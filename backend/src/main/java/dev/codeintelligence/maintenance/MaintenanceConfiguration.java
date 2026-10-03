package dev.codeintelligence.maintenance;

import jakarta.servlet.DispatcherType;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;

@Configuration(proxyBeanMethods = false)
public class MaintenanceConfiguration {
    @Bean
    FilterRegistrationBean<MaintenanceFilter> maintenanceFilter(MaintenanceGate gate) {
        FilterRegistrationBean<MaintenanceFilter> registration =
                new FilterRegistrationBean<>(new MaintenanceFilter(gate));
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE + 10);
        registration.setDispatcherTypes(DispatcherType.REQUEST);
        registration.setAsyncSupported(true);
        registration.addUrlPatterns("/*");
        return registration;
    }
}
