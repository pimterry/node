#include "util.h"
#if HAVE_OPENSSL && HAVE_QUIC
#include "guard.h"
#ifndef OPENSSL_NO_QUIC
#include <async_wrap-inl.h>
#include <debug_utils-inl.h>
#include <node_bob.h>
#include <node_sockaddr-inl.h>
#include <uv.h>
#include <algorithm>
#include "application.h"
#include "defs.h"
#include "session.h"
#include "streams.h"

namespace node {
namespace quic {

// ============================================================================

Session::Application::Application(Session* session) : session_(session) {}

bool Session::Application::Start() {
  // By default there is nothing to do. Specific implementations may
  // override to perform more actions.
  Debug(session_, "Session application started");
  return true;
}

bool Session::Application::AcknowledgeStreamData(stream_id id, size_t datalen) {
  if (auto stream = session().FindStream(id)) [[likely]] {
    stream->Acknowledge(datalen);
  }
  // Returning true even when the stream is not found is intentional.
  // After a stream is destroyed, the peer can still ACK data that was
  // previously sent. This is benign and should not be treated as an error.
  return true;
}

SessionTicket::AppData::Status
Session::Application::ExtractSessionTicketAppData(
    const SessionTicket::AppData& app_data, Flag flag) {
  // By default we do not have any application data to retrieve.
  return flag == Flag::STATUS_RENEW
             ? SessionTicket::AppData::Status::TICKET_USE_RENEW
             : SessionTicket::AppData::Status::TICKET_USE;
}

void Session::Application::ReceiveStreamClose(Stream* stream,
                                              QuicError&& error) {
  DCHECK_NOT_NULL(stream);
  stream->Destroy(std::move(error));
}

void Session::Application::ReceiveStreamStopSending(Stream* stream,
                                                    QuicError&& error) {
  DCHECK_NOT_NULL(stream);
  stream->ReceiveStopSending(std::move(error));
}

void Session::Application::ReceiveStreamReset(Stream* stream,
                                              uint64_t final_size,
                                              QuicError&& error) {
  stream->ReceiveStreamReset(final_size, std::move(error));
}

void Session::Application::ReturnConnectionCredit(size_t datalen) {
  if (datalen == 0 || session().is_destroyed()) return;
  Session::SendPendingDataScope send_scope(&session());
  session().ExtendOffset(datalen);
}

// ============================================================================

// The DefaultApplication is the default implementation of Session::Application
// that is installed when the dynamic-attachment window closes without a
// protocol application (e.g. HTTP/3) having been attached.
class DefaultApplication final : public Session::Application {
 public:
  explicit DefaultApplication(Session* session)
      : Session::Application(session) {}

  Session::Application::Type type() const override {
    return Session::Application::Type::DEFAULT;
  }

  error_code GetNoErrorCode() const override { return 0; }

  // Raw QUIC has no application-defined "general failure" code, so
  // fall back to the QUIC transport-level INTERNAL_ERROR (0x1) used
  // by ngtcp2 for unspecified failures.
  error_code GetInternalErrorCode() const override {
    return NGTCP2_INTERNAL_ERROR;
  }

  void EarlyDataRejected() override {
    // Destroy all open streams — ngtcp2 has already discarded their
    // internal state when it rejected the early data. Use the
    // application's internal error code since this is an error
    // condition (code 0 would be treated as a clean close).
    session().DestroyAllStreams(
        QuicError::ForApplication(GetInternalErrorCode()));
    if (!session().is_destroyed()) {
      session().EmitEarlyDataRejected();
    }
  }

  SessionTicket::AppData::Status ExtractSessionTicketAppData(
      const SessionTicket::AppData& app_data,
      SessionTicket::AppData::Source::Flag flag) override {
    // Application data is only ever produced by named protocol
    // applications, which validate their own. There is nothing here that
    // can check it, so a ticket carrying any is ignored and the handshake
    // falls back to a full 1-RTT exchange.
    auto data = app_data.Get();
    if (data.has_value() && data->len != 0) {
      return SessionTicket::AppData::Status::TICKET_IGNORE_RENEW;
    }
    return flag == SessionTicket::AppData::Source::Flag::STATUS_RENEW
               ? SessionTicket::AppData::Status::TICKET_USE_RENEW
               : SessionTicket::AppData::Status::TICKET_USE;
  }

  void CollectSessionTicketAppData(
      SessionTicket::AppData* app_data) const override {
    // Default sessions embed no application data in session tickets.
  }

  bool ReceiveStreamOpen(stream_id id) override {
    auto stream = session().CreateStream(id);
    if (!stream || session().is_destroyed()) [[unlikely]] {
      return !session().is_destroyed();
    }
    return true;
  }

  bool ReceiveStreamData(stream_id id,
                         const uint8_t* data,
                         size_t datalen,
                         const Stream::ReceiveDataFlags& flags,
                         void* stream_user_data) override {
    BaseObjectPtr<Stream> stream;
    if (stream_user_data == nullptr) {
      // A locally-initiated stream only exists because we created it, so a
      // missing Stream means we already destroyed it. Data the peer had put in
      // flight must not resurrect it as a bogus "incoming" stream. Discard it
      // and return its credit instead. The is_destroyed() check must come
      // first: an earlier callback in this same ngtcp2 batch may have
      // destroyed the session, after which none of this may be touched.
      if (!session().is_destroyed() &&
          ngtcp2_conn_is_local_stream(session(), id)) {
        Debug(&session(),
              "Discarding %zu bytes for destroyed local stream %" PRIi64,
              datalen,
              id);
        ReturnConnectionCredit(datalen);
        return true;
      }

      // This is the first time we're seeing this stream. Implicitly create it.
      stream = session().CreateStream(id);
      if (!stream || session().is_destroyed()) [[unlikely]] {
        // We couldn't create the stream, or the session was destroyed
        // during the onstream callback (via MakeCallback re-entrancy).
        return false;
      }

      // The stream was created but immediately destroyed, either because there
      // is no onstream handler or because the handler destroyed it. Nothing
      // will consume the data, so discard it and return its credit.
      if (stream->is_destroyed()) [[unlikely]] {
        ReturnConnectionCredit(datalen);
        return true;
      }
    } else {
      stream = BaseObjectPtr<Stream>(Stream::From(stream_user_data));
      if (!stream) {
        Debug(&session(),
              "Default application failed to get existing stream "
              "from user data");
        return false;
      }
    }

    CHECK(stream);

    // Now we can actually receive the data! Woo!
    stream->ReceiveData(data, datalen, flags);
    return true;
  }

  int GetStreamData(Session::StreamData* stream_data) override {
    // Reset the state of stream_data before proceeding...
    stream_data->id = -1;
    stream_data->count = 0;
    stream_data->fin = false;
    stream_data->stream.reset();
    Debug(&session(), "Default application getting stream data");
    DCHECK_NOT_NULL(stream_data);
    // If the queue is empty, there aren't any streams with data yet

    // If the connection-level flow control window is exhausted,
    // there is no point in pulling stream data.
    if (!session().max_data_left()) return 0;
    if (stream_queue_.IsEmpty()) return 0;

    Stream* stream = stream_queue_.PopFront();
    CHECK_NOT_NULL(stream);
    stream_data->stream.reset(stream);
    stream_data->id = stream->id();
    auto next =
        [&](int status, const ngtcp2_vec* data, size_t count, bob::Done done) {
          switch (status) {
            case bob::Status::STATUS_BLOCK:
              // Fall through
            case bob::Status::STATUS_WAIT:
              return;
            case bob::Status::STATUS_EOS:
              stream_data->fin = true;
          }

          // It is possible that the data pointers returned are not actually
          // the data pointers in the stream_data. If that's the case, we need
          // to copy over the pointers.
          count = std::min(count, kMaxVectorCount);
          ngtcp2_vec* dest = *stream_data;
          if (dest != data) {
            for (size_t n = 0; n < count; n++) {
              dest[n] = data[n];
            }
          }

          stream_data->count = count;

          if (count > 0) {
            stream->Schedule(&stream_queue_);
          }

          // Not calling done here because we defer committing
          // the data until after we're sure it's written.
        };

    if (!stream->is_eos()) [[likely]] {
      int ret = stream->Pull(std::move(next),
                             bob::Options::OPTIONS_SYNC,
                             stream_data->data,
                             arraysize(stream_data->data),
                             kMaxVectorCount);
      if (ret == bob::Status::STATUS_EOS) {
        stream_data->fin = true;
      }
    } else {
      stream_data->fin = true;
    }

    return 0;
  }

  void ResumeStream(stream_id id) override { ScheduleStream(id); }

  void StreamWriteShut(stream_id id) override {
    if (auto stream = session().FindStream(id)) [[likely]] {
      stream->Unschedule();
    }
  }

  void BlockStream(stream_id id) override {
    if (auto stream = session().FindStream(id)) [[likely]] {
      // Remove the stream from the send queue. It will be re-scheduled
      // via ExtendMaxStreamData when the peer grants more flow control.
      // Without this, SendPendingData would repeatedly pop and retry
      // the same blocked stream in an infinite loop.
      stream->Unschedule();
      stream->EmitBlocked();
    }
  }

  void ExtendMaxStreamData(Stream* stream, uint64_t max_data) override {
    // The peer granted more flow control for this stream. Re-schedule
    // it so SendPendingData will resume writing.
    DCHECK_NOT_NULL(stream);
    stream->UpdateWriteDesiredSize();  // the stream might be blocked on js side
    stream->Schedule(&stream_queue_);
  }

  bool StreamCommit(Session::StreamData* stream_data, size_t datalen) override {
    DCHECK_NOT_NULL(stream_data);
    CHECK(stream_data->stream);
    stream_data->stream->Commit(datalen, stream_data->fin);
    return true;
  }

  SET_SELF_SIZE(DefaultApplication)
  SET_MEMORY_INFO_NAME(DefaultApplication)
  SET_NO_MEMORY_INFO()

 private:
  void ScheduleStream(stream_id id) {
    if (auto stream = session().FindStream(id)) [[likely]] {
      stream->Schedule(&stream_queue_);
    }
  }

  Stream::Queue stream_queue_;
};

std::unique_ptr<Session::Application> CreateDefaultApplication(
    Session* session) {
  return std::make_unique<DefaultApplication>(session);
}

}  // namespace quic
}  // namespace node

#endif  // OPENSSL_NO_QUIC
#endif  // HAVE_OPENSSL && HAVE_QUIC
