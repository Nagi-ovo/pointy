package i18n

// The messages Go says or sends to a page. A test checks that each names
// a message of every catalog.
var (
	LanguageSelf   = key("language.self")
	LanguageSystem = key("language.system")
	LanguageMenu   = key("language.menu")

	TrayApprovals          = key("tray.approvals")
	TrayDNDOn              = key("tray.dndOn")
	TrayAgentOffline       = key("tray.agentOffline")
	TrayExtensionOffline   = key("tray.extensionOffline")
	TrayExtensionConnected = key("tray.extensionConnected")
	TrayExtensionInstall   = key("tray.extensionInstall")
	TrayShake              = key("tray.shake")
	TrayShakeOff           = key("tray.shakeOff")
	TrayShakeLow           = key("tray.shakeLow")
	TrayShakeMedium        = key("tray.shakeMedium")
	TrayShakeHigh          = key("tray.shakeHigh")
	TrayGuide              = key("tray.guide")
	TrayDND                = key("tray.dnd")
	TrayQuit               = key("tray.quit")

	ApprovalTitle = key("approval.title")
	ApprovalBody  = key("approval.body")

	HintAccess     = key("hint.access")
	HintElevated   = key("hint.elevated")
	HintNoHook     = key("hint.noHook")
	HintWebSession = key("hint.webSession")

	NoteExtensionOffline    = key("note.extensionOffline")
	NoteExtensionSilent     = key("note.extensionSilent")
	OverlayExtensionOffline = key("overlay.extensionOffline")

	ControlCustom  = key("control.Custom")
	FieldControl   = key("field.control")
	FieldName      = key("field.name")
	FieldClass     = key("field.class")
	FieldLink      = key("field.link")
	FieldAppWindow = key("field.appWindow")

	PairTitle = key("pair.title")
	PairBody  = key("pair.body")
	PairDeny  = key("pair.deny")
	PairAllow = key("pair.allow")

	WelcomeTitle     = key("welcome.title")
	WelcomeShake     = key("welcome.shake")
	WelcomeTrayMac   = key("welcome.trayMac")
	WelcomeTrayWin   = key("welcome.trayWin")
	WelcomeExtension = key("welcome.extension")
	WelcomeLater     = key("welcome.later")
	WelcomeInstall   = key("welcome.install")

	GuideTitle = key("guide.title")
	GuideWhy   = key("guide.why")
	GuideStep1 = key("guide.step1")
	GuideStep2 = key("guide.step2")
	GuideStep3 = key("guide.step3")
	GuideOK    = key("guide.ok")
)
