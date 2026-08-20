#pragma once

#if defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS

#include <v8.h>
#include <memory>
#include "application.h"
#include "session.h"

namespace node {
class ExternalReferenceRegistry;
namespace quic {

v8::Maybe<std::shared_ptr<void>> ParseHttp3Settings(Environment* env,
                                                    v8::Local<v8::Value> value);
std::unique_ptr<Session::Application> CreateHttp3Application(Session* session);

void CreateHttp3Handle(const v8::FunctionCallbackInfo<v8::Value>& args);

void RegisterHttp3ExternalReferences(ExternalReferenceRegistry* registry);

void InitHttp3PerContext(v8::Local<v8::Object> target);

}  // namespace quic
}  // namespace node

#endif  // defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS
