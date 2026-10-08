package dev.codeintelligence.analysis.java;

import com.github.javaparser.JavaParser;
import com.google.common.util.concurrent.Uninterruptibles;
import java.util.ArrayDeque;
import java.util.Iterator;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * Parses the next few files on helper threads while the caller works on the current one, and hands
 * the results back strictly in input order, so callers see exactly what a sequential loop sees.
 * Parsing is most of the Java analysis CPU time (G-PERF medium/large SOURCE_PARSING), and a file's
 * parse depends only on that file. A {@link JavaParser} is not thread-safe, so each helper thread
 * parses with its own; at most {@link #AHEAD} results are held beyond the caller's current one.
 * Close it to stop the helpers when the caller stops early (cancellation, a failure).
 */
final class ParseAhead<F, T> implements Iterator<ParseAhead.Result<F, T>>, AutoCloseable {

    static final int THREADS = Math.max(1, Math.min(3, Runtime.getRuntime().availableProcessors() - 1));
    static final int AHEAD = 2 * THREADS;

    @FunctionalInterface
    interface Parse<F, T> {
        T parse(JavaParser parser, F file) throws Exception;
    }

    /** One file's parse: its value, or the exception it threw (rethrown by {@link #get()}). */
    record Result<F, T>(F file, T value, Exception failure) {
        T get() throws Exception {
            if (failure != null) throw failure;
            return value;
        }
    }

    private final Iterator<F> files;
    private final ExecutorService helpers;
    private final ThreadLocal<JavaParser> parsers;
    private final Parse<F, T> parse;
    private final ArrayDeque<Future<Result<F, T>>> pending = new ArrayDeque<>();

    ParseAhead(List<F> files, Supplier<JavaParser> parser, Parse<F, T> parse) {
        this.files = files.iterator();
        this.parsers = ThreadLocal.withInitial(parser);
        this.parse = parse;
        // Idle helpers exit on their own, so a caller that stops iterating without closing leaks nothing.
        ThreadPoolExecutor pool = new ThreadPoolExecutor(
                THREADS,
                THREADS,
                5,
                TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(),
                runnable ->
                        Thread.ofPlatform().daemon().name("java-parse-ahead").unstarted(runnable));
        pool.allowCoreThreadTimeOut(true);
        this.helpers = pool;
        fill();
    }

    @Override
    public boolean hasNext() {
        return !pending.isEmpty();
    }

    @Override
    public Result<F, T> next() {
        if (pending.isEmpty()) throw new NoSuchElementException();
        Future<Result<F, T>> head = pending.removeFirst();
        fill();
        try {
            // Bounded by one file's parse; cancellation is checked by the caller between files.
            return Uninterruptibles.getUninterruptibly(head);
        } catch (ExecutionException e) {
            // Only an Error escapes a parse task (exceptions are part of its result).
            if (e.getCause() instanceof Error error) throw error;
            throw new IllegalStateException(e.getCause());
        }
    }

    private void fill() {
        while (pending.size() < AHEAD && files.hasNext()) {
            F file = files.next();
            pending.addLast(helpers.submit(() -> {
                try {
                    return new Result<>(file, parse.parse(parsers.get(), file), null);
                } catch (Exception e) {
                    return new Result<>(file, null, e);
                }
            }));
        }
    }

    @Override
    public void close() {
        helpers.shutdownNow();
        pending.forEach(future -> future.cancel(true));
        pending.clear();
    }
}
