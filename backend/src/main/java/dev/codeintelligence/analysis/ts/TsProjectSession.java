package dev.codeintelligence.analysis.ts;

import dev.codeintelligence.job.JobCancellation;
import dev.codeintelligence.job.JobCancelledException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.function.Supplier;

/**
 * Sends a project larger than one request through the analyzer's session commands (03 §6):
 * open(manifest) → put(chunks of at most 1 MiB, in sequence) → seal(exact manifest) → analyze →
 * result pages → close. Chunks are only the transport unit: the analyzer seals the whole manifest
 * and builds one compiler project, so cross-file resolution is the same as for a single request.
 */
final class TsProjectSession {

    static final int MAX_FILES = 50_000;
    static final long MAX_BYTES = 512L * 1024 * 1024;
    static final int CHUNK_BYTES = 1024 * 1024;

    record Manifest(int fileCount, long bytes, String digest) {}

    /** SHA-256 over {@code path\nsha256(content)\n} per file in send order; the analyzer recomputes it. */
    static final class ManifestBuilder {
        private final MessageDigest digest = sha256();
        private int files;
        private long bytes;

        void add(String path, String content) {
            byte[] encoded = content.getBytes(StandardCharsets.UTF_8);
            String line = path + "\n" + HexFormat.of().formatHex(sha256().digest(encoded)) + "\n";
            digest.update(line.getBytes(StandardCharsets.UTF_8));
            files++;
            bytes += encoded.length;
        }

        Manifest build() {
            return new Manifest(files, bytes, HexFormat.of().formatHex(digest.digest()));
        }
    }

    @FunctionalInterface
    interface SourceReader {
        String read(String path) throws IOException;
    }

    private TsProjectSession() {}

    static void requireWithinLimit(int files, long bytes) {
        if (files > MAX_FILES || bytes > MAX_BYTES) {
            throw new TsAnalyzerException(
                    "Project analysis exceeds the 50000-file / 512 MiB limit. Narrow the source scope.", null);
        }
    }

    static TsAnalyzeDtos.Response analyze(
            TsAnalyzerClient client, List<String> paths, Manifest manifest, SourceReader reader) {
        requireWithinLimit(manifest.fileCount(), manifest.bytes());
        String id =
                call(client, command("open", null, null, null, null, manifest)).id();
        boolean cancelled = false;
        try {
            ManifestBuilder resent = new ManifestBuilder();
            List<TsAnalyzeDtos.FilePayload> chunk = new ArrayList<>();
            long chunkBytes = 0;
            int seq = 0;
            for (String path : paths) {
                JobCancellation.checkpoint();
                String content;
                try {
                    content = reader.read(path);
                } catch (IOException e) {
                    throw new TsAnalyzerException("TS source became unreadable during analysis", null);
                }
                long size = content.getBytes(StandardCharsets.UTF_8).length;
                if (!chunk.isEmpty() && chunkBytes + size > CHUNK_BYTES) {
                    call(client, command("put", id, seq++, null, chunk, null));
                    chunk = new ArrayList<>();
                    chunkBytes = 0;
                }
                resent.add(path, content);
                chunk.add(new TsAnalyzeDtos.FilePayload(path, content));
                chunkBytes += size;
            }
            if (!chunk.isEmpty()) call(client, command("put", id, seq, null, chunk, null));
            if (!resent.build().equals(manifest)) {
                throw new TsAnalyzerException("TS sources changed during analysis", null);
            }
            call(client, command("seal", id, null, null, null, manifest));
            List<TsAnalyzeDtos.Response> pages = new ArrayList<>();
            TsAnalyzeDtos.Response first = page(
                    client, command("analyze", id, null, null, null, null), id, 0, analyzeTimeout(client, manifest));
            pages.add(first);
            for (int page = 1; page < first.session().pages(); page++) {
                pages.add(page(client, command("page", id, null, page, null, null), id, page, client.timeout()));
            }
            return TsAnalyzeDtos.Response.concat(pages);
        } catch (JobCancelledException stopped) {
            // The analyzer drops an idle session after 60 seconds; an interrupted thread cannot call it.
            cancelled = true;
            throw stopped;
        } finally {
            if (!cancelled) {
                try {
                    call(client, command("close", id, null, null, null, null));
                } catch (RuntimeException ignored) {
                    // Best effort: the analyzer also expires idle sessions on its own.
                }
            }
        }
    }

    /**
     * The sealed project is extracted inside the one {@code analyze} command, so it gets the
     * configured request timeout once per single-request budget of source it carries (G-PERF
     * medium: about 25 MiB took 37 s against the 30 s request timeout). Cancellation and the job
     * limits still stop it earlier.
     */
    static Duration analyzeTimeout(TsAnalyzerClient client, Manifest manifest) {
        long budgets = Math.max(1, (manifest.bytes() + TsRequestBudget.MAX_BYTES - 1) / TsRequestBudget.MAX_BYTES);
        return client.timeout().multipliedBy(budgets);
    }

    private static TsAnalyzeDtos.Response page(
            TsAnalyzerClient client, TsAnalyzeDtos.SessionCommand command, String id, int expected, Duration timeout) {
        TsAnalyzeDtos.Response response =
                JobCancellation.interruptibly(() -> client.analyze(TsAnalyzeDtos.Request.session(command), timeout));
        TsAnalyzeDtos.SessionReply reply = response.session();
        if (reply == null
                || !id.equals(reply.id())
                || reply.page() == null
                || reply.page() != expected
                || reply.pages() == null
                || reply.pages() < 1
                || expected >= reply.pages()) {
            throw new TsAnalyzerException("ts-analyzer returned an invalid result page", null);
        }
        return response;
    }

    private static TsAnalyzeDtos.SessionReply call(TsAnalyzerClient client, TsAnalyzeDtos.SessionCommand command) {
        Supplier<TsAnalyzeDtos.Response> request = () -> client.analyze(TsAnalyzeDtos.Request.session(command));
        TsAnalyzeDtos.SessionReply reply =
                JobCancellation.interruptibly(request).session();
        if (reply == null
                || reply.id() == null
                || !reply.id().matches("[0-9a-f]{32}")
                || (command.id() != null && !command.id().equals(reply.id()))
                || !command.op().equals(reply.op())) {
            throw new TsAnalyzerException("ts-analyzer returned an invalid session reply", null);
        }
        return reply;
    }

    private static TsAnalyzeDtos.SessionCommand command(
            String op, String id, Integer seq, Integer page, List<TsAnalyzeDtos.FilePayload> files, Manifest manifest) {
        return new TsAnalyzeDtos.SessionCommand(
                op,
                id,
                seq,
                page,
                files,
                manifest == null ? null : manifest.fileCount(),
                manifest == null ? null : manifest.bytes(),
                manifest == null ? null : manifest.digest());
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
