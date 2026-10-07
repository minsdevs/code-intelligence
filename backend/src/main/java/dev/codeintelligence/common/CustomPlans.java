package dev.codeintelligence.common;

import java.util.function.Supplier;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * Runs key-list lookups ({@code natural_key in (:keys)}, 500 parameters) with plans built for
 * their actual keys. The driver prepares a repeated statement on the server, and after five
 * executions PostgreSQL may keep a generic plan for it on that connection. Built while a
 * snapshot's tables were still empty (the first lookups of SOURCE_PARSING), that plan scans the
 * whole snapshot and compares every row with each parameter; nothing replaces it before later
 * steps look keys up in the filled snapshot (6.5 s per lookup on the large workload). A custom
 * plan sees the keys as one constant array: an index lookup, or at worst one hashed pass.
 * Must run inside a transaction; the setting is restored afterwards and never outlives it.
 */
public final class CustomPlans {

    private CustomPlans() {}

    public static <T> T run(JdbcClient jdbc, Supplier<T> lookups) {
        String previous = jdbc.sql("select current_setting('plan_cache_mode')")
                .query(String.class)
                .single();
        set(jdbc, "force_custom_plan");
        T result = lookups.get();
        set(jdbc, previous);
        return result;
    }

    private static void set(JdbcClient jdbc, String mode) {
        jdbc.sql("select set_config('plan_cache_mode', :mode, true)")
                .param("mode", mode)
                .query(String.class)
                .single();
    }
}
