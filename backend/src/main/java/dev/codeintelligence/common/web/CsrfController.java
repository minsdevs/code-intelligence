package dev.codeintelligence.common.web;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * CSRF cookie priming endpoint for the SPA: the response itself is empty, but passing through
 * the filter chain makes CsrfCookieFilter emit the XSRF-TOKEN cookie.
 */
@RestController
public class CsrfController {

    @GetMapping("/api/csrf")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void csrf() {}
}
