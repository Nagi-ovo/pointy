package desktop

import "regexp"

// loginTitle matches window titles, in Chinese and English, of login,
// password and banking pages.
var loginTitle = regexp.MustCompile(`(?i)密码|口令|password|passcode|登录|登陆|sign[ -]?in|log[ -]?in|网上银行|网银|online banking|支付宝|alipay`)

// LoginTitle reports whether a window or page title looks like a login,
// password or banking page, which Pointy never reads.
func LoginTitle(title string) bool { return loginTitle.MatchString(title) }
