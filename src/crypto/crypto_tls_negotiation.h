#ifndef SRC_CRYPTO_CRYPTO_TLS_NEGOTIATION_H_
#define SRC_CRYPTO_CRYPTO_TLS_NEGOTIATION_H_

#if defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS

#include "crypto/crypto_util.h"
#include "node_constants.h"

namespace node::crypto {

inline constexpr char DEFAULT_TLS13_CIPHER_SUITES[] =
    DEFAULT_TLS13_CIPHER_LIST;

bool SetCipherSuites(SSL_CTX* ctx, const char* ciphers);
bool SetGroups(SSL_CTX* ctx, const char* groups);

#ifdef NODE_OPENSSL_HAS_CERT_COMP
inline constexpr size_t MAX_CERTIFICATE_COMPRESSION_ALGORITHMS =
    TLSEXT_comp_cert_limit - 1;

size_t DecodeCertificateCompressionAlgorithms(uint32_t packed,
                                              int* algorithms,
                                              size_t capacity);
bool ApplyCertificateCompression(SSL_CTX* ctx, uint32_t packed);
#endif

}  // namespace node::crypto

#endif  // defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS
#endif  // SRC_CRYPTO_CRYPTO_TLS_NEGOTIATION_H_
