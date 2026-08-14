package dev.codeintelligence.analysis.core;

/** Extensible graph node kinds (기획서 §6.2). Stored as text so later phases can add values. */
public enum GraphNodeType {
    DIRECTORY,
    FILE,
    PACKAGE,
    MODULE,
    CLASS,
    INTERFACE,
    ENUM,
    ANNOTATION,
    METHOD,
    FIELD,
    COMPONENT,
    HOOK,
    STORE,
    FE_ROUTE,
    API_ENDPOINT,
    DB_ENTITY,
    DB_TABLE,
    MIGRATION,
    CACHE,
    QUEUE_TOPIC,
    EXTERNAL_API,
    CONTAINER,
    CLOUD_RESOURCE,
    CI_PIPELINE,
    TEST_CASE,
    CONFIG
}
