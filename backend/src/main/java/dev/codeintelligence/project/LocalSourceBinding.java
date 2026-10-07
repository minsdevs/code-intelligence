package dev.codeintelligence.project;

/**
 * Private persisted approval input. Never use a client-supplied instance as authority. {@code scope}
 * is the canonical {@link LocalImportScope} the selection was narrowed to, or null for the whole root.
 */
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
        long selectedBytes,
        String scope) {

    /** An unscoped binding (the whole selected root). */
    public LocalSourceBinding(
            int schemaVersion,
            String canonicalRoot,
            String rootPlatform,
            String rootIdentity,
            String rootOwner,
            String policyVersion,
            String limitsSha256,
            String manifestSha256,
            int selectedFiles,
            long selectedBytes) {
        this(
                schemaVersion,
                canonicalRoot,
                rootPlatform,
                rootIdentity,
                rootOwner,
                policyVersion,
                limitsSha256,
                manifestSha256,
                selectedFiles,
                selectedBytes,
                null);
    }
}
