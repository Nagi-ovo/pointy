package pick

import (
	"regexp"

	"github.com/pointylab/pointy/desktop/internal/desktop"
)

// blockedTitle matches window titles, in Chinese and English, of login,
// password and banking pages.
var blockedTitle = regexp.MustCompile(`(?i)密码|口令|password|passcode|登录|登陆|sign[ -]?in|log[ -]?in|网上银行|网银|online banking|支付宝|alipay`)

// blocked reports whether Pointy keeps out of the foreground window: an
// app it never reads, or a window that looks like a login or password page.
func blocked(d desktop.Desktop, fg desktop.Foreground) bool {
	return d.Blocked(fg.Exe) || blockedTitle.MatchString(fg.Title)
}
