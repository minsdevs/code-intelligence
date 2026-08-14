package dev.codeintelligence.analysis.core;

/** Extensible graph edge kinds (기획서 §6.2). Stored as text so later phases can add values. */
public enum GraphEdgeType {
    CONTAINS,
    IMPORTS,
    DECLARES,
    EXTENDS,
    IMPLEMENTS,
    ANNOTATED_BY,
    CALLS,
    USES_TYPE,
    DEPENDS_ON,
    EXPOSES,
    CONSUMES,
    MAPS_TO,
    READS_WRITES,
    PUBLISHES,
    SUBSCRIBES,
    DEPLOYED_IN,
    CONFIGURED_BY,
    TESTED_BY
}
