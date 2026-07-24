'use strict';

const {
  ArrayIsArray,
  ArrayPrototypeFilter,
  ArrayPrototypeJoin,
  StringPrototypeSplit,
  StringPrototypeStartsWith,
} = primordials;

const {
  codes: {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
  },
} = require('internal/errors');

const {
  validateString,
} = require('internal/validators');

function processCiphers(ciphers, name, defaultCiphers) {
  const entries = StringPrototypeSplit(
    ciphers || defaultCiphers || ciphers, ':');

  const cipherList =
    ArrayPrototypeJoin(
      ArrayPrototypeFilter(
        entries,
        (cipher) => {
          if (cipher.length === 0) return false;
          if (StringPrototypeStartsWith(cipher, 'TLS_')) return false;
          if (StringPrototypeStartsWith(cipher, '!TLS_')) return false;
          return true;
        }), ':');

  const cipherSuites =
    ArrayPrototypeJoin(
      ArrayPrototypeFilter(
        entries,
        (cipher) => {
          if (cipher.length === 0) return false;
          if (StringPrototypeStartsWith(cipher, 'TLS_')) return true;
          if (StringPrototypeStartsWith(cipher, '!TLS_')) return true;
          return false;
        }), ':');

  if (cipherSuites === '' && cipherList === '')
    throw new ERR_INVALID_ARG_VALUE(name, entries);

  return { __proto__: null, cipherList, cipherSuites };
}

function narrowCiphers(ciphers, name, family, defaultCiphers) {
  validateString(ciphers, name);
  const result = processCiphers(ciphers, name, defaultCiphers);
  const narrowed = family === 'TLSv1.3' ?
    result.cipherSuites : result.cipherList;
  if (narrowed === '') {
    throw new ERR_INVALID_ARG_VALUE(
      name, ciphers, `contains no ${family}-compatible ciphers`);
  }
  return narrowed;
}

function packCertificateCompression(algorithms, name) {
  if (!ArrayIsArray(algorithms)) {
    throw new ERR_INVALID_ARG_TYPE(name, 'Array', algorithms);
  }
  if (algorithms.length > 3) {
    throw new ERR_INVALID_ARG_VALUE(
      name, algorithms, 'can specify at most 3 algorithms');
  }

  let packed = algorithms.length;
  for (let i = 0; i < algorithms.length; i++) {
    const algorithm = algorithms[i];
    let id;
    if (algorithm === 'zlib') id = 1;
    else if (algorithm === 'brotli') id = 2;
    else if (algorithm === 'zstd') id = 3;
    else {
      throw new ERR_INVALID_ARG_VALUE(
        `${name}[${i}]`, algorithm,
        "must be 'zlib', 'brotli', or 'zstd'");
    }
    packed |= id << (8 * (i + 1));
  }
  return packed;
}

module.exports = {
  narrowCiphers,
  packCertificateCompression,
  processCiphers,
};
