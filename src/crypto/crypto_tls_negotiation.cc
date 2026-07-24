#include "crypto/crypto_tls_negotiation.h"

#include <cstring>

namespace node::crypto {

bool SetCipherSuites(SSL_CTX* ctx, const char* ciphers) {
#ifndef OPENSSL_IS_BORINGSSL
  return SSL_CTX_set_ciphersuites(ctx, ciphers) == 1;
#else
  // BoringSSL does not allow API configuration of TLS 1.3 cipher suites.
  return true;
#endif
}

bool SetGroups(SSL_CTX* ctx, const char* groups) {
  return strcmp(groups, "auto") == 0 ||
         SSL_CTX_set1_groups_list(ctx, groups) == 1;
}

#ifdef NODE_OPENSSL_HAS_CERT_COMP
size_t DecodeCertificateCompressionAlgorithms(uint32_t packed,
                                              int* algorithms,
                                              size_t capacity) {
  const size_t length = packed & 0xff;
  if (length > capacity) return 0;
  for (size_t i = 0; i < length; i++) {
    algorithms[i] = (packed >> (8 * (i + 1))) & 0xff;
  }
  return length;
}

bool ApplyCertificateCompression(SSL_CTX* ctx, uint32_t packed) {
  int algorithms[MAX_CERTIFICATE_COMPRESSION_ALGORITHMS];
  const size_t length = DecodeCertificateCompressionAlgorithms(
      packed, algorithms, MAX_CERTIFICATE_COMPRESSION_ALGORITHMS);
  if ((packed & 0xff) != length ||
      SSL_CTX_set1_cert_comp_preference(ctx, algorithms, length) != 1) {
    return false;
  }
  if (length > 0) {
    // Returns 0 when no certificate is loaded or compression does not reduce
    // its size. Both are non-fatal.
    constexpr int kCompressAllAlgorithms = 0;
    SSL_CTX_compress_certs(ctx, kCompressAllAlgorithms);
  }
  return true;
}
#endif  // NODE_OPENSSL_HAS_CERT_COMP

}  // namespace node::crypto
