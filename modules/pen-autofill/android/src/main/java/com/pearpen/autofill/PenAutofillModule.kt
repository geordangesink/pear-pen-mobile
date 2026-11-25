package com.pearpen.autofill

import android.view.autofill.AutofillManager
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PenAutofillModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PenAutofill")

    AsyncFunction("commit") {
      appContext.currentActivity?.getSystemService(AutofillManager::class.java)?.commit()
    }.runOnQueue(Queues.MAIN)
  }
}
