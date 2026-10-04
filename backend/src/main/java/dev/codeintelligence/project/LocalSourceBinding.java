package dev.codeintelligence.project;

/** Private persisted approval input. Never use a client-supplied instance as authority. */
public record LocalSourceBinding(
        int schemaVersion,
        String canonicalRoot,
        String rootPlatform,
        String rootIdentity,
        String rootOwner,
        String policyVersion,
        String limitsSha256,
        String manifestSha256,
        int selectedFiles,
        long selectedBytes) {}
