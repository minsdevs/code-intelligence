package dev.codeintelligence.project;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.codeintelligence.common.AppProperties;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;
import org.eclipse.jgit.internal.storage.file.ObjectDirectory;
import org.eclipse.jgit.lib.Config;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectDatabase;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectInserter;
import org.eclipse.jgit.lib.ObjectReader;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.treewalk.TreeWalk;
import org.eclipse.jgit.util.FS;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;

class RetainedRunWorkspaceTest {
    private static final Instant APPROVED_AT = Instant.parse("2026-10-03T12:34:56.789Z");
    private static final byte[] PUBLIC_SOURCE = "export const greeting = 'hello';\r\n".getBytes(StandardCharsets.UTF_8);

    @TempDir
    Path temp;

    private AppProperties properties() {
        return new AppProperties(temp.resolve("data").toString(), 2);
    }

    private Path runs() {
        return properties().reposRoot().resolve(".analysis-runs");
    }

    private RetainedRunWorkspace workspace() {
        return new RetainedRunWorkspace(properties());
    }

    private LocalImportService importer(AppProperties app) throws IOException {
        var limits = new LocalSourcePolicy.Limits(
                50_000,
                2 * 1024 * 1024,
                512L * 1024 * 1024,
                50_000,
                200_000,
                64,
                Duration.ofSeconds(30).toNanos());
        return new LocalImportService(
                app,
                new LocalImportProperties(temp.toRealPath().toString()),
                new DesktopPathAuthorizationService(),
                new LocalSourcePolicy(limits, () -> 0, path -> {}),
                LocalImportService::moveDirectory);
    }

    private record Fixture(RetainedRunWorkspace.Manifest manifest, Map<String, byte[]> blobs, Path source) {
        byte[] read(String hash, long size) throws IOException {
            byte[] bytes = blobs.get(hash);
            if (bytes == null) throw new IOException("synthetic source missing");
            return bytes.clone();
        }
    }

    /** The independent existing import path supplies the expected commit, not the class under test. */
    private Fixture fixture(Map<String, byte[]> files) throws Exception {
        Path source = Files.createDirectory(temp.resolve("source-" + UUID.randomUUID()));
        for (var file : files.entrySet()) {
            Path path = source.resolve(file.getKey());
            Files.createDirectories(path.getParent());
            Files.write(path, file.getValue());
        }
        var imports = importer(properties());
        var binding = imports.inspect(source).binding();
        List<RetainedRunWorkspace.Entry> entries = new ArrayList<>();
        Map<String, byte[]> blobs = new HashMap<>();
        var imported = imports.importApproved(
                binding,
                properties().reposRoot().resolve("fixture-" + UUID.randomUUID()),
                () -> {},
                new LocalImportService.VerifiedFileSink() {
                    @Override
                    public void accept(String path, String gitOid, byte[] bytes) {
                        String hash = sha256(bytes);
                        entries.add(new RetainedRunWorkspace.Entry(path, gitOid, hash, bytes.length));
                        blobs.put(hash, bytes.clone());
                    }

                    @Override
                    public Instant commitTime() {
                        return APPROVED_AT;
                    }
                });
        assertThat(binding.selectedFiles()).isEqualTo(files.size());
        return new Fixture(
                new RetainedRunWorkspace.Manifest(
                        imported.headSha(),
                        APPROVED_AT,
                        binding.policyVersion(),
                        binding.limitsSha256(),
                        binding.manifestSha256(),
                        binding.selectedFiles(),
                        binding.selectedBytes(),
                        entries),
                Map.copyOf(blobs),
                source);
    }

    private Fixture fixture() throws Exception {
        return fixture(Map.of("src/a.ts", PUBLIC_SOURCE));
    }

    private static String sha256(byte[] bytes) {
        return HexFormat.of().formatHex(LocalSourceManifest.sha256().digest(bytes));
    }

    private static RetainedRunWorkspace.Entry entry(String path, byte[] bytes) {
        try (var formatter = new ObjectInserter.Formatter()) {
            return new RetainedRunWorkspace.Entry(
                    path, formatter.idFor(Constants.OBJ_BLOB, bytes).name(), sha256(bytes), bytes.length);
        }
    }

    private static RetainedRunWorkspace.Manifest withEntries(
            RetainedRunWorkspace.Manifest original, List<RetainedRunWorkspace.Entry> entries, boolean recompute) {
        long total =
                entries.stream().mapToLong(RetainedRunWorkspace.Entry::byteSize).sum();
        String digest = original.manifestSha256();
        if (recompute) {
            // Encode the wire digest without the production builder's sorting validation. Negative
            // fixtures need a matching digest even for duplicate/unsorted/unsafe path sequences;
            // otherwise the final digest mismatch can hide a missing structural validator.
            var manifest = LocalSourceManifest.sha256();
            LocalSourceManifest.string(manifest, "code-intelligence-local-manifest-v1");
            LocalSourceManifest.string(manifest, original.policyVersion());
            LocalSourceManifest.string(manifest, original.limitsSha256());
            for (var entry : entries) {
                manifest.update((byte) 1);
                LocalSourceManifest.string(manifest, entry.path());
                LocalSourceManifest.string(manifest, "REGULAR_FILE");
                LocalSourceManifest.number(manifest, entry.byteSize());
                manifest.update(HexFormat.of().parseHex(entry.rawSha256()));
            }
            manifest.update((byte) 0);
            LocalSourceManifest.number(manifest, entries.size());
            LocalSourceManifest.number(manifest, total);
            digest = HexFormat.of().formatHex(manifest.digest());
        }
        return new RetainedRunWorkspace.Manifest(
                original.snapshotSha(),
                original.approvedAt(),
                original.policyVersion(),
                original.limitsSha256(),
                digest,
                entries.size(),
                total,
                entries);
    }

    private static void fails(String code, org.assertj.core.api.ThrowableAssert.ThrowingCallable action) {
        assertThatThrownBy(action)
                .isInstanceOf(RetainedRunWorkspace.WorkspaceException.class)
                .hasMessage(code)
                .hasNoCause()
                .satisfies(error -> assertThat(((RetainedRunWorkspace.WorkspaceException) error).code())
                        .isEqualTo(code));
    }

    @Test
    void unusedServiceIsLazyAndClosingDoesNotCreateStorage() {
        workspace().close();
        assertThat(properties().reposRoot()).doesNotExist();
    }

    @Test
    void leaseHasPrivateFreshStorageAndCloseDeletesOnlyItsOwnRun() throws Exception {
        try (var service = workspace()) {
            var first = service.create(7, 11);
            var second = service.create(7, 12);
            Path firstPath = first.clonePath();
            Path secondPath = second.clonePath();
            Files.writeString(firstPath.resolve("public.txt"), "public synthetic bytes");
            assertThat(first.projectId()).isEqualTo(7);
            assertThat(first.jobId()).isEqualTo(11);
            assertThat(Files.getPosixFilePermissions(firstPath))
                    .isEqualTo(PosixFilePermissions.fromString("rwx------"));
            assertThat(Files.getPosixFilePermissions(firstPath.getParent()))
                    .isEqualTo(PosixFilePermissions.fromString("rwx------"));
            assertThat(Files.getPosixFilePermissions(runs().resolve("owner.lock")))
                    .isEqualTo(PosixFilePermissions.fromString("rw-------"));
            first.close();
            first.close();
            assertThat(firstPath.getParent()).doesNotExist();
            assertThat(secondPath).isDirectory();
            fails("WORKSPACE_LEASE_INVALID", first::clonePath);
            second.close();
        }
        try (var entries = Files.list(runs())) {
            assertThat(entries.map(path -> path.getFileName().toString()).toList())
                    .containsExactly("owner.lock");
        }
    }

    @Test
    void exactRawBytesAndDeterministicGitCommitMatchExistingImporter() throws Exception {
        Map<String, byte[]> originals = Map.of(
                "src/a.ts",
                PUBLIC_SOURCE,
                "unicode-한.txt",
                "\uFEFFfirst\r\n한글\n".getBytes(StandardCharsets.UTF_8),
                "empty.txt",
                new byte[0]);
        Fixture fixture = fixture(originals);
        // The original source can disappear: reconstruction has no source-path parameter or fallback.
        for (String name : originals.keySet()) Files.delete(fixture.source().resolve(name));
        try (var service = workspace();
                var lease = service.create(7, 11)) {
            assertThat(service.reconstruct(lease, fixture.manifest(), fixture::read))
                    .isEqualTo(fixture.manifest().snapshotSha());
            Path clone = lease.clonePath();
            for (var file : originals.entrySet())
                assertThat(Files.readAllBytes(clone.resolve(file.getKey()))).isEqualTo(file.getValue());
            assertThat(Files.readString(clone.resolve(".git/HEAD"))).isEqualTo("ref: refs/heads/snapshot\n");
            assertThat(Files.readString(clone.resolve(".git/refs/heads/snapshot")))
                    .isEqualTo(fixture.manifest().snapshotSha() + "\n");
            try (ObjectDatabase objects = new ObjectDirectory(
                            new Config(),
                            clone.resolve(".git/objects").toFile(),
                            null,
                            FS.DETECTED,
                            clone.resolve(".git/shallow").toFile());
                    ObjectReader reader = objects.newReader();
                    RevWalk revisions = new RevWalk(reader);
                    TreeWalk tree = new TreeWalk(reader)) {
                var commit = revisions.parseCommit(
                        ObjectId.fromString(fixture.manifest().snapshotSha()));
                assertThat(commit.getParentCount()).isZero();
                assertThat(commit.getAuthorIdent().getName()).isEqualTo("Code Intelligence");
                assertThat(commit.getFullMessage()).isEqualTo("Code Intelligence local snapshot");
                tree.addTree(commit.getTree());
                tree.setRecursive(true);
                Map<String, byte[]> retained = new HashMap<>();
                while (tree.next())
                    retained.put(
                            tree.getPathString(),
                            reader.open(tree.getObjectId(0)).getBytes());
                assertThat(retained.keySet()).isEqualTo(originals.keySet());
                originals.forEach(
                        (path, bytes) -> assertThat(retained.get(path)).isEqualTo(bytes));
            }
            try (var paths = Files.walk(clone)) {
                for (Path path : paths.toList())
                    assertThat(Files.getPosixFilePermissions(path))
                            .isEqualTo(PosixFilePermissions.fromString(
                                    Files.isDirectory(path) ? "rwx------" : "rw-------"));
            }
            fails("WORKSPACE_LEASE_INVALID", () -> service.reconstruct(lease, fixture.manifest(), fixture::read));
        }
    }

    @Test
    void emptySnapshotCanBeReconstructed() throws Exception {
        Fixture fixture = fixture(Map.of());
        try (var service = workspace();
                var lease = service.create(7, 11)) {
            assertThat(service.reconstruct(lease, fixture.manifest(), (hash, size) -> {
                        throw new AssertionError("empty manifest must not read blobs");
                    }))
                    .isEqualTo(fixture.manifest().snapshotSha());
        }
    }

    @Test
    void fileExactlyAtTwoMiBLimitRetainsItsFullBytes() throws Exception {
        byte[] bytes = new byte[2 * 1024 * 1024];
        Arrays.fill(bytes, (byte) 'a');
        Fixture fixture = fixture(Map.of("large.txt", bytes));
        try (var service = workspace();
                var lease = service.create(7, 11)) {
            service.reconstruct(lease, fixture.manifest(), fixture::read);
            assertThat(Files.readAllBytes(lease.clonePath().resolve("large.txt")))
                    .isEqualTo(bytes);
        }
    }

    static Stream<String> unsafePaths() {
        return Stream.of(
                "../outside",
                "a/../../outside",
                "/absolute",
                "./file",
                "a//b",
                "a/",
                "a\\b",
                ".git/config",
                "a/.git/config",
                "a/.GIT/config",
                "C:drive",
                "a/%2e%2e/b",
                "a/%2fb",
                "a/%5cb",
                "a/\u0000b",
                "a/\uD800bad",
                "a/\nfile",
                "a/" + "x".repeat(256),
                "d/".repeat(64) + "f");
    }

    @ParameterizedTest
    @MethodSource("unsafePaths")
    void rejectsUnsafePathsBeforeBlobReadAndCleansLease(String path) throws Exception {
        Fixture fixture = fixture();
        var invalid = withEntries(fixture.manifest(), List.of(entry(path, PUBLIC_SOURCE)), true);
        try (var service = workspace()) {
            var lease = service.create(7, 11);
            Path run = lease.clonePath().getParent();
            AtomicInteger calls = new AtomicInteger();
            fails(
                    "WORKSPACE_INVALID_MANIFEST",
                    () -> service.reconstruct(lease, invalid, (hash, size) -> {
                        calls.incrementAndGet();
                        return PUBLIC_SOURCE;
                    }));
            assertThat(calls).hasValue(0);
            assertThat(run).doesNotExist();
        }
    }

    static Stream<List<String>> conflictingPaths() {
        return Stream.of(
                List.of("b.ts", "a.ts"),
                List.of("a.ts", "a.ts"),
                List.of("a", "a-", "a/b"),
                List.of("A/a", "a/b"),
                List.of("cafe\u0301.txt", "café.txt"));
    }

    @ParameterizedTest
    @MethodSource("conflictingPaths")
    void rejectsUnsortedDuplicatePrefixAndFilesystemAliasCollisions(List<String> paths) throws Exception {
        Fixture fixture = fixture();
        var invalid = withEntries(
                fixture.manifest(),
                paths.stream().map(path -> entry(path, PUBLIC_SOURCE)).toList(),
                true);
        AtomicInteger calls = new AtomicInteger();
        try (var service = workspace();
                var lease = service.create(7, 11)) {
            fails(
                    "WORKSPACE_INVALID_MANIFEST",
                    () -> service.reconstruct(lease, invalid, (hash, size) -> {
                        calls.incrementAndGet();
                        return fixture.read(hash, size);
                    }));
            assertThat(calls).hasValue(0);
        }
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "snapshot",
                "approval-time",
                "policy",
                "limits",
                "digest",
                "count",
                "total",
                "oid",
                "raw",
                "file-size"
            })
    void rejectsMalformedOrInconsistentMetadata(String field) throws Exception {
        Fixture fixture = fixture();
        var original = fixture.manifest();
        var file = original.entries().getFirst();
        var entry = new RetainedRunWorkspace.Entry(
                file.path(),
                field.equals("oid") ? "F".repeat(40) : file.gitOid(),
                field.equals("raw") ? "G".repeat(64) : file.rawSha256(),
                field.equals("file-size") ? 2_097_153 : file.byteSize());
        var candidate = new RetainedRunWorkspace.Manifest(
                field.equals("snapshot") ? "0" : original.snapshotSha(),
                field.equals("approval-time") ? Instant.MIN : original.approvedAt(),
                field.equals("policy") ? "future-policy" : original.policyVersion(),
                field.equals("limits") ? "0".repeat(64) : original.limitsSha256(),
                field.equals("digest") ? "0".repeat(64) : original.manifestSha256(),
                field.equals("count") ? 2 : original.fileCount(),
                field.equals("total") ? 512L * 1024 * 1024 + 1 : original.totalBytes(),
                List.of(entry));
        var invalid = field.equals("file-size") ? withEntries(original, List.of(entry), true) : candidate;
        AtomicInteger calls = new AtomicInteger();
        try (var service = workspace();
                var lease = service.create(7, 11)) {
            fails(
                    "WORKSPACE_INVALID_MANIFEST",
                    () -> service.reconstruct(lease, invalid, (hash, size) -> {
                        calls.incrementAndGet();
                        return fixture.read(hash, size);
                    }));
            assertThat(calls).hasValue(0);
        }
    }

    @Test
    void metadataAggregateAndFileCountAreBoundedBeforeReadingAnySource() throws Exception {
        Fixture fixture = fixture();
        List<RetainedRunWorkspace.Entry> entries = new ArrayList<>();
        for (int index = 0; index < 35_000; index++) {
            entries.add(entry("d".repeat(180) + "/" + String.format("%05d", index) + "f".repeat(180), new byte[0]));
        }
        var tooLarge = withEntries(fixture.manifest(), entries, true);
        AtomicInteger calls = new AtomicInteger();
        try (var service = workspace();
                var lease = service.create(7, 11)) {
            fails(
                    "WORKSPACE_INVALID_MANIFEST",
                    () -> service.reconstruct(lease, tooLarge, (hash, size) -> {
                        calls.incrementAndGet();
                        return new byte[0];
                    }));
            assertThat(calls).hasValue(0);
        }
        fails(
                "WORKSPACE_INVALID_MANIFEST",
                () -> withEntries(
                        fixture.manifest(),
                        java.util.Collections.nCopies(
                                50_001, fixture.manifest().entries().getFirst()),
                        false));
    }

    @Test
    void aggregateDirectoryCountIsBoundedEvenWhenMetadataAndFileCountsFit() throws Exception {
        Fixture fixture = fixture();
        var entries = new ArrayList<RetainedRunWorkspace.Entry>();
        for (int index = 0; index < 3300; index++) {
            entries.add(entry(
                    String.format(java.util.Locale.ROOT, "%04d", index) + "/d".repeat(62) + "/file", new byte[0]));
        }
        // Each path has the allowed depth, but the paths have more than 200,000 distinct parents.
        var invalid = withEntries(fixture.manifest(), entries, true);
        try (var service = workspace();
                var lease = service.create(7, 11)) {
            fails(
                    "WORKSPACE_INVALID_MANIFEST",
                    () -> service.reconstruct(lease, invalid, (hash, size) -> {
                        throw new AssertionError("traversal metadata must be rejected before any blob read");
                    }));
        }
    }

    @Test
    void immutableManifestDefensivelyCopiesTheCallerList() throws Exception {
        Fixture fixture = fixture();
        var entries = new ArrayList<>(fixture.manifest().entries());
        var manifest = withEntries(fixture.manifest(), entries, false);
        entries.clear();
        assertThat(manifest.entries()).hasSize(1);
        assertThatThrownBy(() -> manifest.entries().clear()).isInstanceOf(UnsupportedOperationException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing", "null", "hash", "short", "oversized", "git-oid", "commit"})
    void sourceFailureNeverUsesLiveFilesAndDeletesPartialPlaintext(String change) throws Exception {
        Fixture fixture = fixture(Map.of(
                "a.ts", PUBLIC_SOURCE, "b.ts", "export const second = true;\n".getBytes(StandardCharsets.UTF_8)));
        var manifest = fixture.manifest();
        if (change.equals("git-oid")) {
            var entries = new ArrayList<>(manifest.entries());
            var last = entries.getLast();
            entries.set(
                    entries.size() - 1,
                    new RetainedRunWorkspace.Entry(last.path(), "0".repeat(40), last.rawSha256(), last.byteSize()));
            manifest = withEntries(manifest, entries, true);
        } else if (change.equals("commit")) {
            manifest = new RetainedRunWorkspace.Manifest(
                    "0".repeat(40),
                    manifest.approvedAt(),
                    manifest.policyVersion(),
                    manifest.limitsSha256(),
                    manifest.manifestSha256(),
                    manifest.fileCount(),
                    manifest.totalBytes(),
                    manifest.entries());
        }
        var supplied = manifest;
        try (var service = workspace()) {
            var lease = service.create(7, 11);
            Path run = lease.clonePath().getParent();
            AtomicInteger calls = new AtomicInteger();
            fails(
                    change.equals("missing") ? "WORKSPACE_SOURCE_UNAVAILABLE" : "WORKSPACE_SOURCE_INTEGRITY",
                    () -> service.reconstruct(lease, supplied, (hash, size) -> {
                        if (calls.incrementAndGet() == 1 || change.equals("git-oid") || change.equals("commit"))
                            return fixture.read(hash, size);
                        return switch (change) {
                            case "missing" -> throw new IOException("/synthetic/private/path must not leak");
                            case "null" -> null;
                            case "hash" -> {
                                byte[] bytes = fixture.read(hash, size);
                                bytes[0] ^= 1;
                                yield bytes;
                            }
                            case "short" -> new byte[0];
                            case "oversized" -> new byte[2_097_153];
                            default -> throw new AssertionError(change);
                        };
                    }));
            assertThat(calls.get()).isGreaterThanOrEqualTo(2);
            assertThat(run).doesNotExist();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"nul", "invalid-utf8", "late-nul"})
    void malformedTextIsRejectedEvenWhenBothContentHashesMatch(String type) throws Exception {
        Fixture fixture = fixture();
        byte[] bytes =
                switch (type) {
                    case "nul" -> new byte[] {'a', 0, 'b'};
                    case "invalid-utf8" -> new byte[] {(byte) 0xc3, 0x28};
                    default -> {
                        byte[] content = new byte[9000];
                        Arrays.fill(content, (byte) 'a');
                        content[8999] = 0;
                        yield content;
                    }
                };
        var manifest = withEntries(fixture.manifest(), List.of(entry("src/a.ts", bytes)), true);
        try (var service = workspace();
                var lease = service.create(7, 11)) {
            fails("WORKSPACE_SOURCE_INTEGRITY", () -> service.reconstruct(lease, manifest, (hash, size) -> bytes));
        }
    }

    @Test
    void foreignLeaseAndNonemptyRepositoryAreNotReconstructed() throws Exception {
        Fixture fixture = fixture();
        try (var service = workspace();
                var other = workspace();
                var lease = service.create(7, 11)) {
            fails("WORKSPACE_LEASE_INVALID", () -> other.reconstruct(lease, fixture.manifest(), fixture::read));
            Path run = lease.clonePath().getParent();
            Files.writeString(lease.clonePath().resolve("already.txt"), "synthetic existing source");
            fails("WORKSPACE_LEASE_INVALID", () -> service.reconstruct(lease, fixture.manifest(), fixture::read));
            assertThat(run).doesNotExist();
        }
    }

    @Test
    void lockIsExclusiveAndCannotBeReleasedWhileAnyLeaseIsAlive() throws Exception {
        var first = workspace();
        var lease = first.create(7, 11);
        try (var contender = workspace()) {
            fails("WORKSPACE_BUSY", () -> contender.create(7, 12));
            fails("WORKSPACE_ACTIVE_LEASES", first::close);
            fails("WORKSPACE_BUSY", () -> contender.create(7, 12));
            lease.close();
            first.close();
            try (var next = contender.create(7, 12)) {
                assertThat(next.clonePath()).isDirectory();
            }
        } finally {
            lease.close();
            first.close();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"same-root", "parent-alias"})
    void rejectedSameJvmContenderDoesNotReleaseTheOwnersActualOperatingSystemLock(String kind) throws Exception {
        AppProperties contenderProperties = properties();
        if (kind.equals("parent-alias")) {
            Path alias = Files.createSymbolicLink(temp.resolve("parent-alias"), temp.toRealPath());
            contenderProperties = new AppProperties(alias.resolve("data").toString(), 2);
        }
        assertContenderCannotDropOsLock(properties(), contenderProperties);
    }

    @Test
    void actualCaseVariantAliasesShareTheJvmReservationWhenSupportedByTheFilesystem() throws Exception {
        Path canonicalParent = Files.createDirectory(temp.resolve("CaseVariantParent"));
        Path caseVariant = temp.resolve("casevariantparent");
        org.junit.jupiter.api.Assumptions.assumeTrue(
                Files.exists(caseVariant) && Files.isSameFile(canonicalParent, caseVariant),
                "This filesystem does not expose an actual case-insensitive alias");
        assertContenderCannotDropOsLock(
                new AppProperties(canonicalParent.resolve("data").toString(), 2),
                new AppProperties(caseVariant.resolve("data").toString(), 2));
    }

    private void assertContenderCannotDropOsLock(AppProperties ownerProperties, AppProperties contenderProperties)
            throws Exception {
        var service = new RetainedRunWorkspace(ownerProperties);
        var lease = service.create(7, 11);
        Path ownerLock = ownerProperties.reposRoot().resolve(".analysis-runs/owner.lock");
        try (var contender = new RetainedRunWorkspace(contenderProperties)) {
            assertThat(externalLockState(ownerLock)).isEqualTo("BUSY");
            fails("WORKSPACE_BUSY", () -> contender.create(7, 12));
            // On macOS, closing any descriptor for the locked inode can release this process's
            // POSIX lock while the first Java FileLock still reports valid. An in-JVM retry cannot
            // detect that loss: only a separate JVM can prove the OS lock remains held.
            assertThat(externalLockState(ownerLock)).isEqualTo("BUSY");
            contender.close();
            assertThat(externalLockState(ownerLock)).isEqualTo("BUSY");
            fails("WORKSPACE_ACTIVE_LEASES", service::close);
            assertThat(externalLockState(ownerLock)).isEqualTo("BUSY");
        } finally {
            lease.close();
            service.close();
        }
        assertThat(externalLockState(ownerLock)).isEqualTo("ACQUIRED");
    }

    private String externalLockState(Path ownerLock) throws Exception {
        try (var probe = startExternalLockProbe(ownerLock, false)) {
            assertThat(probe.child().waitFor(15, TimeUnit.SECONDS))
                    .as("synthetic child JVM lock probe finished")
                    .isTrue();
            assertThat(probe.child().exitValue()).isZero();
            assertThat(Files.size(probe.output())).isLessThan(1024);
            return Files.readString(probe.output()).strip();
        }
    }

    private record ExternalLockProbe(Process child, Path output) implements AutoCloseable {
        @Override
        public void close() throws Exception {
            if (child.isAlive()) {
                try {
                    child.getOutputStream().close();
                } finally {
                    if (!child.waitFor(5, TimeUnit.SECONDS)) {
                        child.destroyForcibly();
                        child.waitFor(5, TimeUnit.SECONDS);
                    }
                }
            }
        }
    }

    private ExternalLockProbe startExternalLockProbe(Path ownerLock, boolean hold) throws Exception {
        Path probe = temp.resolve("RetainedOwnerLockProbe.java");
        if (!Files.exists(probe)) {
            Files.writeString(probe, """
                    import java.nio.channels.FileChannel;
                    import java.nio.file.LinkOption;
                    import java.nio.file.Path;
                    import java.nio.file.StandardOpenOption;

                    public class RetainedOwnerLockProbe {
                        public static void main(String[] args) throws Exception {
                            try (var channel = FileChannel.open(Path.of(args[0]),
                                        StandardOpenOption.READ, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
                                    var lock = channel.tryLock()) {
                                System.out.println(lock == null ? "BUSY" : "ACQUIRED");
                                if (args.length == 2 && lock != null) System.in.read();
                            }
                        }
                    }
                    """);
        }
        Path output = temp.resolve("lock-probe-" + UUID.randomUUID() + ".txt");
        List<String> arguments = new ArrayList<>(List.of(
                Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                probe.toString(),
                ownerLock.toString()));
        if (hold) arguments.add("hold");
        var command = new ProcessBuilder(arguments);
        for (String option : List.of("JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS"))
            command.environment().remove(option);
        Process child = command.redirectErrorStream(true)
                .redirectOutput(output.toFile())
                .start();
        return new ExternalLockProbe(child, output);
    }

    @Test
    void externalProcessLockRefusalReleasesOnlyTheFailedJvmReservation() throws Exception {
        initializedClosedRoot();
        Path ownerLock = runs().resolve("owner.lock");
        try (var failed = workspace()) {
            try (var held = startExternalLockProbe(ownerLock, true)) {
                org.awaitility.Awaitility.await()
                        .atMost(Duration.ofSeconds(15))
                        .untilAsserted(
                                () -> assertThat(Files.readString(held.output()).strip())
                                        .isEqualTo("ACQUIRED"));
                fails("WORKSPACE_BUSY", () -> failed.create(7, 11));
                assertThat(externalLockState(ownerLock)).isEqualTo("BUSY");
            }
            // The OS owner exited. Retrying the same failed service must reserve the JVM root anew.
            try (var lease = failed.create(7, 11)) {
                assertThat(lease.clonePath()).isDirectory();
                assertThat(externalLockState(ownerLock)).isEqualTo("BUSY");
            }
        }
        assertThat(externalLockState(ownerLock)).isEqualTo("ACQUIRED");
    }

    @Test
    void failedOrphanValidationDoesNotLeaveAStaleReservationOrReleaseANewOwner() throws Exception {
        initializedClosedRoot();
        Path unexpected = Files.writeString(runs().resolve("unexpected.txt"), "synthetic unknown entry");
        Path ownerLock = runs().resolve("owner.lock");
        try (var failed = workspace()) {
            fails("WORKSPACE_UNAVAILABLE", () -> failed.create(7, 11));
            assertThat(externalLockState(ownerLock)).isEqualTo("ACQUIRED");
            Files.delete(unexpected);
            try (var next = workspace();
                    var lease = next.create(7, 12)) {
                fails("WORKSPACE_BUSY", () -> failed.create(7, 13));
                failed.close();
                assertThat(externalLockState(ownerLock)).isEqualTo("BUSY");
                assertThat(lease.clonePath()).isDirectory();
            }
        }
    }

    @Test
    void independentCanonicalRootsCanBothHoldRealOperatingSystemLocks() throws Exception {
        AppProperties different = new AppProperties(temp.resolve("other-data").toString(), 2);
        try (var first = workspace();
                var second = new RetainedRunWorkspace(different);
                var firstLease = first.create(7, 11);
                var secondLease = second.create(7, 11)) {
            assertThat(firstLease.clonePath()).isDirectory();
            assertThat(secondLease.clonePath()).isDirectory();
            assertThat(externalLockState(runs().resolve("owner.lock"))).isEqualTo("BUSY");
            assertThat(externalLockState(different.reposRoot().resolve(".analysis-runs/owner.lock")))
                    .isEqualTo("BUSY");
        }
    }

    @Test
    void concurrentLeasesAreDistinctBoundedAndDuplicateJobsAreRejected() throws Exception {
        try (var service = workspace();
                var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var futures = new ArrayList<java.util.concurrent.Future<RetainedRunWorkspace.Lease>>();
            for (long job = 11; job < 15; job++) {
                long id = job;
                futures.add(executor.submit(() -> service.create(7, id)));
            }
            List<RetainedRunWorkspace.Lease> leases = new ArrayList<>();
            try {
                for (var future : futures) leases.add(future.get(5, TimeUnit.SECONDS));
                assertThat(leases.stream()
                                .map(RetainedRunWorkspace.Lease::clonePath)
                                .distinct()
                                .count())
                        .isEqualTo(4);
                fails("WORKSPACE_BUSY", () -> service.create(7, 15));
                leases.removeFirst().close();
                fails("WORKSPACE_BUSY", () -> service.create(8, 12));
                try (var last = service.create(7, 15)) {
                    assertThat(last.clonePath()).isDirectory();
                }
            } finally {
                leases.forEach(RetainedRunWorkspace.Lease::close);
            }
        }
    }

    private void initializedClosedRoot() {
        try (var service = workspace();
                var ignored = service.create(7, 11)) {
            // Leaves only the empty, private lock file.
        }
    }

    private Path orphan() throws IOException {
        Path orphan = Files.createDirectory(
                runs().resolve("run-" + UUID.randomUUID()),
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        Files.writeString(
                orphan.resolve("owner.meta"),
                "code-intelligence-retained-run-v1\n" + orphan.getFileName() + "\n7\n11\n");
        Files.setPosixFilePermissions(orphan.resolve("owner.meta"), PosixFilePermissions.fromString("rw-------"));
        Path repo = Files.createDirectory(
                orphan.resolve("repo"),
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        Files.writeString(repo.resolve("public.txt"), "synthetic interrupted plaintext");
        return orphan;
    }

    @Test
    void nextStartupRemovesVerifiedCrashShapedOrphansBeforeCreatingNewLease() throws Exception {
        initializedClosedRoot();
        Path previous = orphan();
        try (var service = workspace();
                var lease = service.create(7, 12)) {
            assertThat(previous).doesNotExist();
            assertThat(lease.clonePath()).isDirectory();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"unknown-sibling", "unknown-run", "missing-marker", "wrong-marker", "symlink", "hardlink"})
    void unsafeOrUnknownStartupEntriesBlockBeforeAnyVerifiedOrphanIsDeleted(String type) throws Exception {
        initializedClosedRoot();
        Path previous = orphan();
        Path unsafe = orphan();
        Path outside = Files.writeString(temp.resolve("outside.txt"), "public outside sentinel");
        switch (type) {
            case "unknown-sibling" -> Files.writeString(runs().resolve("someone-elses-file"), "leave intact");
            case "unknown-run" -> Files.createDirectory(runs().resolve("run-unknown"));
            case "missing-marker" -> Files.delete(unsafe.resolve("owner.meta"));
            case "wrong-marker" -> Files.writeString(unsafe.resolve("owner.meta"), "not our owner marker");
            case "symlink" -> Files.createSymbolicLink(unsafe.resolve("repo/linked"), outside);
            case "hardlink" -> Files.createLink(unsafe.resolve("repo/linked"), outside);
            default -> throw new AssertionError(type);
        }
        try (var service = workspace()) {
            fails("WORKSPACE_UNAVAILABLE", () -> service.create(7, 12));
        }
        assertThat(previous.resolve("repo/public.txt")).hasContent("synthetic interrupted plaintext");
        assertThat(outside).hasContent("public outside sentinel");
    }

    @ParameterizedTest
    @ValueSource(strings = {"symlink", "hardlink", "permissions", "payload"})
    void unsafeOwnerLockFailsClosed(String type) throws Exception {
        initializedClosedRoot();
        Path ownerLock = runs().resolve("owner.lock");
        Path outside = Files.writeString(temp.resolve("outside.txt"), "public outside sentinel");
        switch (type) {
            case "symlink" -> {
                Files.delete(ownerLock);
                Files.createSymbolicLink(ownerLock, outside);
            }
            case "hardlink" -> {
                Files.delete(ownerLock);
                Files.createLink(ownerLock, outside);
            }
            case "permissions" ->
                Files.setPosixFilePermissions(ownerLock, PosixFilePermissions.fromString("rw-r--r--"));
            case "payload" -> Files.writeString(ownerLock, "not an empty OS lock");
            default -> throw new AssertionError(type);
        }
        try (var service = workspace()) {
            fails("WORKSPACE_UNAVAILABLE", () -> service.create(7, 11));
        }
        assertThat(outside).hasContent("public outside sentinel");
    }

    @Test
    void symlinkedApplicationOwnedReposRootIsNotFollowed() throws Exception {
        Path data = Files.createDirectory(temp.resolve("data"));
        Path outside = Files.createDirectory(temp.resolve("outside"));
        Files.createSymbolicLink(data.resolve("repos"), outside);
        try (var service = workspace()) {
            fails("WORKSPACE_UNAVAILABLE", () -> service.create(7, 11));
        }
        assertThat(outside.resolve(".analysis-runs")).doesNotExist();
    }

    @ParameterizedTest
    @ValueSource(strings = {"symlink", "hardlink"})
    void cleanupRefusesLinksRetainsOwnershipAndBlocksNewWork(String type) throws Exception {
        var service = workspace();
        var lease = service.create(7, 11);
        Path run = lease.clonePath().getParent();
        Path outside = Files.writeString(temp.resolve("outside.txt"), "public outside sentinel");
        Path link = type.equals("symlink")
                ? Files.createSymbolicLink(lease.clonePath().resolve("linked"), outside)
                : Files.createLink(lease.clonePath().resolve("linked"), outside);
        try (var contender = workspace()) {
            fails("WORKSPACE_UNAVAILABLE", lease::close);
            fails("WORKSPACE_ACTIVE_LEASES", service::close);
            fails("WORKSPACE_UNAVAILABLE", () -> service.create(7, 12));
            fails("WORKSPACE_BUSY", () -> contender.create(7, 12));
            assertThat(externalLockState(runs().resolve("owner.lock"))).isEqualTo("BUSY");
            assertThat(run.resolve("owner.meta")).exists();
            assertThat(outside).hasContent("public outside sentinel");
        } finally {
            Files.delete(link);
            lease.close();
            service.close();
        }
        assertThat(run).doesNotExist();
    }

    @Test
    void sourceParentSymlinkCannotRedirectPlaintextWrites() throws Exception {
        Fixture fixture = fixture();
        var service = workspace();
        var lease = service.create(7, 11);
        Path repo = lease.clonePath();
        Path outside = Files.createDirectory(temp.resolve("outside"));
        try {
            fails(
                    "WORKSPACE_UNAVAILABLE",
                    () -> service.reconstruct(lease, fixture.manifest(), (hash, size) -> {
                        Files.createSymbolicLink(repo.resolve("src"), outside);
                        return fixture.read(hash, size);
                    }));
            assertThat(outside.resolve("a.ts")).doesNotExist();
            fails("WORKSPACE_ACTIVE_LEASES", service::close);
        } finally {
            Files.delete(repo.resolve("src"));
            lease.close();
            service.close();
        }
    }

    @Test
    void originalLexicalAliasCanBeUsedByExistingImporterAndRetainedReconstruction() throws Exception {
        Path actualParent = Files.createDirectory(temp.resolve("actual-parent"));
        Path alias = Files.createSymbolicLink(temp.resolve("configured-parent"), actualParent);
        AppProperties app = new AppProperties(alias.resolve("data").toString(), 2);
        Path source = Files.createDirectory(temp.resolve("alias-source"));
        Files.write(source.resolve("a.ts"), PUBLIC_SOURCE);
        var imports = importer(app);
        try (var service = new RetainedRunWorkspace(app);
                var lease = service.create(7, 11)) {
            assertThat(lease.clonePath()).startsWith(app.reposRoot());
            imports.importApproved(imports.inspect(source).binding(), lease.clonePath());
            assertThat(Files.readAllBytes(lease.clonePath().resolve("a.ts"))).isEqualTo(PUBLIC_SOURCE);
        }
        Fixture fixture = fixture();
        try (var service = new RetainedRunWorkspace(app);
                var lease = service.create(7, 12)) {
            service.reconstruct(lease, fixture.manifest(), fixture::read);
            assertThat(Files.readAllBytes(lease.clonePath().resolve("src/a.ts")))
                    .isEqualTo(PUBLIC_SOURCE);
        }
    }

    @Test
    void interruptedReconstructionPreservesInterruptAndCleansTheLease() throws Exception {
        Fixture fixture = fixture();
        try (var service = workspace()) {
            var lease = service.create(7, 11);
            Path run = lease.clonePath().getParent();
            try {
                Thread.currentThread().interrupt();
                fails("WORKSPACE_CANCELLED", () -> service.reconstruct(lease, fixture.manifest(), fixture::read));
                assertThat(Thread.currentThread().isInterrupted()).isTrue();
            } finally {
                Thread.interrupted();
            }
            assertThat(run).doesNotExist();
        }
    }

    @Test
    void interruptionDuringBlobReadStillRemovesAlreadyWrittenSource() throws Exception {
        Fixture fixture = fixture(Map.of(
                "a.ts", PUBLIC_SOURCE, "b.ts", "export const second = true;\n".getBytes(StandardCharsets.UTF_8)));
        try (var service = workspace()) {
            var lease = service.create(7, 11);
            Path run = lease.clonePath().getParent();
            AtomicInteger calls = new AtomicInteger();
            try {
                fails(
                        "WORKSPACE_CANCELLED",
                        () -> service.reconstruct(lease, fixture.manifest(), (hash, size) -> {
                            if (calls.incrementAndGet() == 2) {
                                Thread.currentThread().interrupt();
                                throw new IOException("synthetic interrupted read");
                            }
                            return fixture.read(hash, size);
                        }));
                assertThat(Thread.currentThread().isInterrupted()).isTrue();
                assertThat(calls).hasValue(2);
            } finally {
                Thread.interrupted();
            }
            assertThat(run).doesNotExist();
        }
    }

    @Test
    void timeLimitIncludesTimeSpentReadingBlobsAndCleansPartialWork() throws Exception {
        Fixture fixture = fixture();
        AtomicLong time = new AtomicLong();
        try (var service = new RetainedRunWorkspace(properties(), time::get)) {
            var lease = service.create(7, 11);
            Path run = lease.clonePath().getParent();
            fails(
                    "WORKSPACE_TIMEOUT",
                    () -> service.reconstruct(lease, fixture.manifest(), (hash, size) -> {
                        time.addAndGet(Duration.ofSeconds(31).toNanos());
                        return fixture.read(hash, size);
                    }));
            assertThat(run).doesNotExist();
        }
    }
}
