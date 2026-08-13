package dev.codeintelligence.auth;

/** Ciphertext is base64 (matches the text column); nonce is raw bytes (bytea column). */
public record EncryptedToken(int keyVersion, byte[] nonce, String ciphertext) {}
