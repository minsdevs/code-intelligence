package dev.codeintelligence.job;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.OptionalLong;
import java.util.concurrent.TimeUnit;

/**
 * Resident memory of one process tree from a single {@code ps} snapshot (macOS and Linux). Shared
 * pages are counted once per process, as the workload runner's owner-tree samples count them.
 */
final class ProcessTreeMemory implements AnalysisMemoryWatchdog.ResidentMemory {
    private static final int MAX_OUTPUT = 4 * 1024 * 1024;
    private final long root;

    ProcessTreeMemory(long root) {
        this.root = root;
    }

    @Override
    public OptionalLong ownerTreeBytes() {
        Process ps = null;
        try {
            ps = new ProcessBuilder(List.of("/bin/ps", "-axo", "pid=,ppid=,rss="))
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start();
            ps.getOutputStream().close();
            byte[] output;
            try (InputStream in = ps.getInputStream()) {
                output = in.readNBytes(MAX_OUTPUT + 1);
            }
            if (output.length > MAX_OUTPUT || !ps.waitFor(2, TimeUnit.SECONDS) || ps.exitValue() != 0)
                return OptionalLong.empty();
            return ownerTreeBytes(new String(output, StandardCharsets.US_ASCII), root);
        } catch (IOException | RuntimeException error) {
            return OptionalLong.empty();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return OptionalLong.empty();
        } finally {
            if (ps != null) ps.destroyForcibly();
        }
    }

    static OptionalLong ownerTreeBytes(String table, long root) {
        Map<Long, Long> rssKib = new HashMap<>();
        Map<Long, List<Long>> children = new HashMap<>();
        for (String line : table.split("\n")) {
            if (line.isBlank()) continue;
            String[] fields = line.trim().split("\\s+");
            if (fields.length != 3) return OptionalLong.empty();
            try {
                long pid = Long.parseLong(fields[0]);
                long parent = Long.parseLong(fields[1]);
                rssKib.put(pid, Long.parseLong(fields[2]));
                children.computeIfAbsent(parent, ignored -> new java.util.ArrayList<>())
                        .add(pid);
            } catch (NumberFormatException malformed) {
                return OptionalLong.empty();
            }
        }
        if (!rssKib.containsKey(root)) return OptionalLong.empty();
        long total = 0;
        var seen = new HashSet<Long>();
        var pending = new ArrayDeque<Long>(List.of(root));
        while (!pending.isEmpty()) {
            long pid = pending.pop();
            if (!seen.add(pid)) continue;
            total += rssKib.getOrDefault(pid, 0L);
            for (long child : children.getOrDefault(pid, List.of())) if (child != pid) pending.push(child);
        }
        return OptionalLong.of(total * 1024);
    }
}
