package dev.codeintelligence.project;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

@ResponseStatus(HttpStatus.BAD_REQUEST)
public class IdeOpenNotSupportedException extends RuntimeException {
    public IdeOpenNotSupportedException(String message) {
        super(message);
    }
}
