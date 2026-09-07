package dev.systemslibrarian.truepad.app

/**
 * A STEP OF THE TWO-DEVICE EXCHANGE, run one at a time and never by the suite.
 *
 * These tests take runner arguments — a receive code, a couriered package path, a
 * message to open — and are meaningless without them. Left in the ordinary
 * instrumentation run they would fail for want of an argument and make the suite
 * count non-deterministic, so the default run excludes this annotation and each
 * step is invoked explicitly by name.
 */
annotation class CrossEditionStep
