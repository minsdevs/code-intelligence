package dev.codeintelligence.note;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class NoteReferenceParserTest {

    @Test
    void extractsSupportedReferenceForms() {
        var refs = NoteReferenceParser.parse("""
                See @file:src/App.java and @class#save and @commit abcdef1
                plus @task:12 and [[Auth notes]].
                """);
        assertThat(refs)
                .extracting(NoteReferenceParser.ParsedRef::type)
                .contains(
                        NoteReferenceParser.SubjectType.FILE,
                        NoteReferenceParser.SubjectType.NODE,
                        NoteReferenceParser.SubjectType.COMMIT,
                        NoteReferenceParser.SubjectType.TASK,
                        NoteReferenceParser.SubjectType.NOTE);
        assertThat(refs)
                .extracting(NoteReferenceParser.ParsedRef::rawTarget)
                .contains("src/App.java", "save", "abcdef1", "12", "Auth notes");
    }
}
