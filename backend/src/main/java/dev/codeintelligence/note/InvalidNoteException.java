package dev.codeintelligence.note;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

public class InvalidNoteException extends ErrorResponseException {

    public InvalidNoteException() {
        super(
                HttpStatus.BAD_REQUEST,
                ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Note is invalid."),
                null);
    }
}
