package dev.systemslibrarian.truepad.app

import android.app.Application
import dev.systemslibrarian.truepad.storage.Engine

/**
 * One process, one engine.
 *
 * The engine holds no mutable state of its own — every verb reads the store,
 * decides, writes, and returns — but it does own the per-pair lock table that
 * serialises writers. Two Engine instances over the same directory would still
 * be safe (the lock is an OS file lock as well as an in-process one), but there
 * is no reason to have two, and one place to construct it is one place to get
 * the two directory bindings right.
 */
class TruePadApp : Application() {

    val engine: Engine by lazy { AndroidStorage.engineFor(this) }

    override fun onCreate() {
        super.onCreate()
        // Anything left in the export scratch directory belongs to a previous
        // run that was interrupted between writing a copy and handing it over.
        // Best-effort hygiene, not erasure.
        AndroidStorage.clearExportCache(this)
    }
}
