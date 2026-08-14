CREATE TABLE todos (
    id bigserial PRIMARY KEY,
    title text NOT NULL,
    done boolean NOT NULL DEFAULT false
);
