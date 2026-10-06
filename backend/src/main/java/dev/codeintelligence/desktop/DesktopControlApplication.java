package dev.codeintelligence.desktop;

/** Minimal desktop control entrypoint. It never starts Spring. */
public final class DesktopControlApplication {
    private DesktopControlApplication() {}

    public static void main(String[] args) {
        int code = run(args);
        if (code != 0) System.exit(code);
    }

    static int run(String[] args) {
        if (NativeLeaseWorker.requested(args)) return NativeLeaseWorker.run(args, System.in, System.out);
        if (ManagedProcessWorker.requested(args)) return ManagedProcessWorker.run(args, System.in, System.out);
        return 2;
    }
}
