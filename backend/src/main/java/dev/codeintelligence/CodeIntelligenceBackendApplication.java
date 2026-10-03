package dev.codeintelligence;

import dev.codeintelligence.backup.BackupSourceWorker;
import dev.codeintelligence.desktop.ManagedProcessWorker;
import dev.codeintelligence.desktop.NativeLeaseWorker;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class CodeIntelligenceBackendApplication {

    public static void main(String[] args) {
        if (NativeLeaseWorker.requested(args)) {
            int result = NativeLeaseWorker.run(args, System.in, System.out);
            if (result != 0) System.exit(result);
            return;
        }
        if (ManagedProcessWorker.requested(args)) {
            int result = ManagedProcessWorker.run(args, System.in, System.out);
            if (result != 0) System.exit(result);
            return;
        }
        if (BackupSourceWorker.requested(args)) {
            int result = BackupSourceWorker.run(args, System.in, System.out);
            if (result != 0) System.exit(result);
            return;
        }
        SpringApplication.run(CodeIntelligenceBackendApplication.class, args);
    }
}
