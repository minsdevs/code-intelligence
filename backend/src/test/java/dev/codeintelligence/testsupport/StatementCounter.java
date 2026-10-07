package dev.codeintelligence.testsupport;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.datasource.DelegatingDataSource;

/** Counts statement executions (one database round trip each, a batch counts once). */
@TestConfiguration(proxyBeanMethods = false)
public class StatementCounter {

    public static final AtomicInteger EXECUTIONS = new AtomicInteger();

    private static final Set<String> EXECUTE = Set.of(
            "execute", "executeQuery", "executeUpdate", "executeLargeUpdate", "executeBatch", "executeLargeBatch");

    @Bean
    static BeanPostProcessor countingDataSourcePostProcessor() {
        return new BeanPostProcessor() {
            @Override
            public Object postProcessAfterInitialization(Object bean, String beanName) {
                if (!(bean instanceof DataSource dataSource) || bean instanceof DelegatingDataSource) {
                    return bean;
                }
                return new DelegatingDataSource(dataSource) {
                    @Override
                    public Connection getConnection() throws SQLException {
                        return counting(super.getConnection());
                    }

                    @Override
                    public Connection getConnection(String username, String password) throws SQLException {
                        return counting(super.getConnection(username, password));
                    }
                };
            }
        };
    }

    private static Connection counting(Connection connection) {
        return (Connection) Proxy.newProxyInstance(
                Connection.class.getClassLoader(), new Class<?>[] {Connection.class}, (proxy, method, args) -> {
                    Object result = invoke(connection, method, args);
                    if (result instanceof Statement statement) {
                        Class<?> type = statement instanceof java.sql.CallableStatement
                                ? java.sql.CallableStatement.class
                                : statement instanceof java.sql.PreparedStatement
                                        ? java.sql.PreparedStatement.class
                                        : Statement.class;
                        return Proxy.newProxyInstance(
                                Connection.class.getClassLoader(), new Class<?>[] {type}, (p, m, a) -> {
                                    if (EXECUTE.contains(m.getName())) EXECUTIONS.incrementAndGet();
                                    return invoke(statement, m, a);
                                });
                    }
                    return result;
                });
    }

    private static Object invoke(Object target, java.lang.reflect.Method method, Object[] args) throws Throwable {
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException e) {
            throw e.getCause();
        }
    }
}
