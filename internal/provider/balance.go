package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/khc8655/llmproxy2/internal/types"
	"github.com/khc8655/llmproxy2/internal/upstream"
)

var (
	balanceKeyRegex = regexp.MustCompile(`(?i)\$?\{\{?\s*(?:key|api[_-]?key|token)\s*\}?\}`)
	errNoAPIKey     = errors.New("missing API key for balance query")
)

// BalancePart represents one labeled slice or segment of balance details.
type BalancePart struct {
	Label   string   `json:"label,omitempty"`
	Text    string   `json:"text"`
	Percent *float64 `json:"percent,omitempty"`
	Error   string   `json:"error,omitempty"`
}

// BalanceResult represents the standardized outcome of querying balance and quotas.
type BalanceResult struct {
	Amount      string        `json:"amount"`                 // e.g. "$12.34" or "¥100.00"
	Currency    string        `json:"currency,omitempty"`    // "USD", "CNY", etc.
	Total       float64       `json:"total,omitempty"`
	Granted     float64       `json:"granted,omitempty"`     // 赠送
	ToppedUp    float64       `json:"topped_up,omitempty"`   // 充值
	AccountWide bool          `json:"account_wide,omitempty"`
	Parts       []BalancePart `json:"parts,omitempty"`
	Raw         string        `json:"raw,omitempty"`
}

// withBalanceKey replaces {key}, {apiKey}, {api_key}, {token} placeholders with the key.
func withBalanceKey(s, key string, inURL bool) string {
	if inURL {
		key = url.QueryEscape(key)
	}
	return balanceKeyRegex.ReplaceAllLiteralString(s, key)
}

// formatMoney formats a currency sign with a numeric amount to 2 decimal places.
func formatMoney(sign string, v float64) string {
	return sign + strconv.FormatFloat(v, 'f', 2, 64)
}

// parseNumber converts interface value (float64, string, json.Number) to float64.
func parseNumber(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	}
	return 0, false
}

// QueryBalance queries the live balance and quota for a given provider.
func QueryBalance(ctx context.Context, client *http.Client, provider *types.ProviderConfig, apiKey string) (*BalanceResult, error) {
	if provider == nil {
		return nil, errors.New("provider config is required")
	}

	if apiKey == "" && len(provider.APIKeys) > 0 && provider.APIKeys[0] != nil {
		apiKey = provider.APIKeys[0].Key
	}

	if client == nil {
		client = upstream.DefaultClient(15*time.Second, true)
	}

	baseURL := strings.ToLower(provider.BaseURL)
	preset := strings.ToLower(provider.PresetID)
	balanceURL := strings.ToLower(provider.BalanceURL)

	// Check native vendor drivers first
	switch {
	case preset == "deepseek" || strings.Contains(baseURL, "deepseek.com") || strings.Contains(balanceURL, "deepseek.com"):
		u := "https://api.deepseek.com/user/balance"
		if provider.BalanceURL != "" {
			u = provider.BalanceURL
		}
		return queryDeepSeekBalance(ctx, client, u, apiKey)

	case preset == "moonshot-cn" || strings.Contains(baseURL, "moonshot.cn") || strings.Contains(baseURL, "kimi.com") || strings.Contains(balanceURL, "moonshot.cn"):
		u := "https://api.moonshot.cn/v1/users/me/balance"
		if provider.BalanceURL != "" {
			u = provider.BalanceURL
		}
		return queryMoonshotBalance(ctx, client, u, "¥", apiKey)

	case preset == "moonshot" || strings.Contains(baseURL, "moonshot.ai") || strings.Contains(baseURL, "kimi.ai") || strings.Contains(balanceURL, "moonshot.ai"):
		u := "https://api.moonshot.ai/v1/users/me/balance"
		if provider.BalanceURL != "" {
			u = provider.BalanceURL
		}
		return queryMoonshotBalance(ctx, client, u, "$", apiKey)

	case preset == "openrouter" || strings.Contains(baseURL, "openrouter.ai") || strings.Contains(balanceURL, "openrouter.ai"):
		u := "https://openrouter.ai/api/v1/credits"
		if provider.BalanceURL != "" {
			u = provider.BalanceURL
		}
		return queryOpenRouterBalance(ctx, client, u, apiKey)

	case preset == "stepfun-cn" || strings.Contains(baseURL, "stepfun.com") || strings.Contains(balanceURL, "stepfun.com"):
		u := "https://api.stepfun.com/v1/accounts"
		if provider.BalanceURL != "" {
			u = provider.BalanceURL
		}
		return queryStepFunBalance(ctx, client, u, "¥", apiKey)

	case preset == "stepfun" || strings.Contains(baseURL, "stepfun.ai") || strings.Contains(balanceURL, "stepfun.ai"):
		u := "https://api.stepfun.ai/v1/accounts"
		if provider.BalanceURL != "" {
			u = provider.BalanceURL
		}
		return queryStepFunBalance(ctx, client, u, "$", apiKey)

	case strings.Contains(baseURL, "/api/user/self") || strings.Contains(baseURL, "/api/usage/token") ||
		strings.Contains(balanceURL, "/api/user/self") || strings.Contains(balanceURL, "/api/usage/token"):
		u := provider.BaseURL
		if provider.BalanceURL != "" {
			u = provider.BalanceURL
		}
		return queryOneAPIBalance(ctx, client, u, apiKey)
	}

	// Custom BalanceURL configured on provider
	if strings.TrimSpace(provider.BalanceURL) != "" {
		return queryCustomBalance(ctx, client, provider, apiKey)
	}

	return nil, fmt.Errorf("no balance driver available for provider %q (%s)", provider.ID, provider.BaseURL)
}

// queryCustomBalance handles provider.BalanceURL and provider.BalancePath.
func queryCustomBalance(ctx context.Context, client *http.Client, provider *types.ProviderConfig, apiKey string) (*BalanceResult, error) {
	rawURL := provider.BalanceURL
	if apiKey == "" && balanceKeyRegex.MatchString(rawURL) {
		return nil, errNoAPIKey
	}

	targetURL := withBalanceKey(rawURL, apiKey, true)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, err
	}

	// Set auth header unless key placeholder was consumed in URL
	if apiKey != "" && !strings.Contains(rawURL, "{") {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}

	// Check standard One-API refusal
	if refusal, isRefusal := checkRefusal(body); isRefusal {
		return nil, errors.New(refusal)
	}

	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("balance endpoint returned HTTP %d: %s", resp.StatusCode, parseErrorSnippet(body, resp.Status))
	}

	path := strings.TrimSpace(provider.BalancePath)
	if path == "" {
		// Infer default path for common panel patterns
		switch {
		case strings.HasSuffix(rawURL, "/api/user/self"):
			path = "$data.quota / 500000"
		case strings.HasSuffix(rawURL, "/api/usage/token") || strings.HasSuffix(rawURL, "/api/key/usage"):
			path = "$data.total_available / 500000"
		default:
			path = "data.balance"
		}
	}

	amountStr, parts, err := evalBalanceParts(body, path)
	if err != nil {
		return nil, err
	}

	res := &BalanceResult{
		Amount: amountStr,
		Parts:  parts,
		Raw:    string(body),
	}
	// Try parsing numeric total from amount
	clean := strings.TrimLeft(amountStr, "$¥€£ ")
	if f, err := strconv.ParseFloat(clean, 64); err == nil {
		res.Total = f
	}

	return res, nil
}

// queryDeepSeekBalance queries DeepSeek balance.
func queryDeepSeekBalance(ctx context.Context, client *http.Client, queryURL, apiKey string) (*BalanceResult, error) {
	if apiKey == "" {
		return nil, errNoAPIKey
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, queryURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("deepseek balance returned HTTP %d: %s", resp.StatusCode, parseErrorSnippet(body, resp.Status))
	}

	var ds struct {
		IsAvailable  bool `json:"is_available"`
		BalanceInfos []struct {
			Currency string `json:"currency"`
			Total    any    `json:"total_balance"`
			Granted  any    `json:"granted_balance"`
			Topped   any    `json:"topped_up_balance"`
		} `json:"balance_infos"`
	}
	if err := json.Unmarshal(body, &ds); err != nil {
		return nil, err
	}
	if len(ds.BalanceInfos) == 0 {
		return nil, errors.New("no balance infos in deepseek response")
	}

	type curAmt struct {
		code    string
		total   float64
		granted float64
		topped  float64
	}
	var amts []curAmt
	for _, info := range ds.BalanceInfos {
		tot, _ := parseNumber(info.Total)
		grn, _ := parseNumber(info.Granted)
		top, _ := parseNumber(info.Topped)
		amts = append(amts, curAmt{
			code:    strings.ToUpper(info.Currency),
			total:   tot,
			granted: grn,
			topped:  top,
		})
	}

	// Sort positive balance first, then by code
	slices.SortStableFunc(amts, func(a, b curAmt) int {
		if (a.total > 0) != (b.total > 0) {
			if a.total > 0 {
				return -1
			}
			return 1
		}
		return strings.Compare(a.code, b.code)
	})

	primary := amts[0]
	sign := "¥"
	if primary.code == "USD" {
		sign = "$"
	}

	var parts []BalancePart
	if primary.granted > 0 {
		parts = append(parts, BalancePart{Label: "Granted", Text: formatMoney(sign, primary.granted)})
	}
	if primary.topped > 0 {
		parts = append(parts, BalancePart{Label: "Topped up", Text: formatMoney(sign, primary.topped)})
	}

	var textParts []string
	for _, a := range amts {
		s := "¥"
		if a.code == "USD" {
			s = "$"
		}
		textParts = append(textParts, formatMoney(s, a.total))
	}

	return &BalanceResult{
		Amount:      strings.Join(textParts, " · "),
		Currency:    primary.code,
		Total:       primary.total,
		Granted:     primary.granted,
		ToppedUp:    primary.topped,
		AccountWide: true,
		Parts:       parts,
		Raw:         string(body),
	}, nil
}

// queryMoonshotBalance queries Moonshot/Kimi balance endpoints.
func queryMoonshotBalance(ctx context.Context, client *http.Client, queryURL, sign, apiKey string) (*BalanceResult, error) {
	if apiKey == "" {
		return nil, errNoAPIKey
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, queryURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("moonshot balance returned HTTP %d: %s", resp.StatusCode, parseErrorSnippet(body, resp.Status))
	}

	var r struct {
		Data struct {
			Available any `json:"available_balance"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, err
	}
	val, ok := parseNumber(r.Data.Available)
	if !ok {
		return nil, errors.New("no available_balance in moonshot response")
	}

	curr := "USD"
	if sign == "¥" {
		curr = "CNY"
	}

	return &BalanceResult{
		Amount:      formatMoney(sign, val),
		Currency:    curr,
		Total:       val,
		AccountWide: true,
		Raw:         string(body),
	}, nil
}

// queryOpenRouterBalance queries OpenRouter credits.
func queryOpenRouterBalance(ctx context.Context, client *http.Client, queryURL, apiKey string) (*BalanceResult, error) {
	if apiKey == "" {
		return nil, errNoAPIKey
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, queryURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("openrouter credits returned HTTP %d: %s", resp.StatusCode, parseErrorSnippet(body, resp.Status))
	}

	var r struct {
		Data struct {
			Credits any `json:"total_credits"`
			Usage   any `json:"total_usage"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, err
	}
	credits, ok := parseNumber(r.Data.Credits)
	if !ok {
		return nil, errors.New("no total_credits in openrouter response")
	}
	usage, _ := parseNumber(r.Data.Usage)
	rem := credits - usage

	return &BalanceResult{
		Amount:      formatMoney("$", rem),
		Currency:    "USD",
		Total:       rem,
		AccountWide: true,
		Raw:         string(body),
	}, nil
}

// queryStepFunBalance queries StepFun accounts endpoint.
func queryStepFunBalance(ctx context.Context, client *http.Client, queryURL, sign, apiKey string) (*BalanceResult, error) {
	if apiKey == "" {
		return nil, errNoAPIKey
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, queryURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("stepfun balance returned HTTP %d: %s", resp.StatusCode, parseErrorSnippet(body, resp.Status))
	}

	var r struct {
		Balance any `json:"balance"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, err
	}
	bal, ok := parseNumber(r.Balance)
	if !ok {
		return nil, errors.New("no balance in stepfun response")
	}

	curr := "USD"
	if sign == "¥" {
		curr = "CNY"
	}

	return &BalanceResult{
		Amount:      formatMoney(sign, bal),
		Currency:    curr,
		Total:       bal,
		AccountWide: true,
		Raw:         string(body),
	}, nil
}

// queryOneAPIBalance handles One-API/New-API standard balance endpoints.
func queryOneAPIBalance(ctx context.Context, client *http.Client, rawURL, apiKey string) (*BalanceResult, error) {
	if apiKey == "" {
		return nil, errNoAPIKey
	}
	targetURL := withBalanceKey(rawURL, apiKey, true)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}

	if msg, refused := checkRefusal(body); refused {
		return nil, errors.New(msg)
	}

	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("one-api balance returned HTTP %d: %s", resp.StatusCode, parseErrorSnippet(body, resp.Status))
	}

	var r struct {
		Success bool `json:"success"`
		Data    struct {
			Quota          any `json:"quota"`
			TotalAvailable any `json:"total_available"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, err
	}

	var quotaVal float64
	var found bool
	if q, ok := parseNumber(r.Data.Quota); ok {
		quotaVal, found = q, true
	} else if a, ok := parseNumber(r.Data.TotalAvailable); ok {
		quotaVal, found = a, true
	}

	if !found {
		return nil, errors.New("neither quota nor total_available found in response")
	}

	dollars := quotaVal / 500000.0
	return &BalanceResult{
		Amount:      formatMoney("$", dollars),
		Currency:    "USD",
		Total:       dollars,
		AccountWide: r.Data.Quota != nil,
		Raw:         string(body),
	}, nil
}

func checkRefusal(b []byte) (string, bool) {
	var r struct {
		Success *bool  `json:"success"`
		Message string `json:"message"`
	}
	if json.Unmarshal(b, &r) == nil && r.Success != nil && !*r.Success && strings.TrimSpace(r.Message) != "" {
		return strings.TrimSpace(r.Message), true
	}
	return "", false
}

// ============================================================================
// Expression and JSONPath dot evaluator (ported cleanly from Magpie)
// ============================================================================

// evalBalanceParts evaluates single or multi-part balance path expressions.
func evalBalanceParts(body []byte, path string) (string, []BalancePart, error) {
	if !strings.Contains(path, ";") && !strings.Contains(path, ":") {
		v, pct, err := evalBalanceOne(body, path)
		if err != nil {
			return "", nil, err
		}
		part := BalancePart{Text: v, Percent: pct}
		return v, []BalancePart{part}, nil
	}

	var out []BalancePart
	var firstErr error
	hasRead := false

	parts := strings.Split(path, ";")
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		label, expr, hasColon := strings.Cut(p, ":")
		if !hasColon {
			label, expr = "", p
		}
		label = strings.TrimSpace(label)
		v, pct, err := evalBalanceOne(body, expr)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			out = append(out, BalancePart{Label: label, Text: "—", Error: err.Error()})
			continue
		}
		hasRead = true
		out = append(out, BalancePart{Label: label, Text: v, Percent: pct})
	}

	if len(out) == 0 {
		return "", nil, errors.New("no valid balance path")
	}
	if !hasRead {
		return "", nil, firstErr
	}

	var joined []string
	for _, part := range out {
		if part.Label != "" {
			joined = append(joined, part.Label+" "+part.Text)
		} else {
			joined = append(joined, part.Text)
		}
	}
	return strings.Join(joined, " · "), out, nil
}

// evalBalanceOne evaluates a single expression over JSON data.
func evalBalanceOne(body []byte, exprStr string) (string, *float64, error) {
	exprStr = strings.TrimSpace(exprStr)
	sign := ""
	for _, s := range []string{"$", "¥", "€", "£"} {
		if strings.HasPrefix(exprStr, s) {
			sign = s
			exprStr = strings.TrimSpace(strings.TrimPrefix(exprStr, s))
			break
		}
	}
	percent := false
	if strings.HasSuffix(exprStr, "%") {
		percent = true
		exprStr = strings.TrimSpace(strings.TrimSuffix(exprStr, "%"))
	}
	if exprStr == "" {
		return "", nil, errors.New("empty balance path")
	}

	var root any
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	if err := d.Decode(&root); err != nil {
		return "", nil, errors.New("response is not valid JSON")
	}

	be := &balanceExpr{src: exprStr, reply: root}
	if be.isLonePath() {
		val, err := be.getAt(exprStr)
		if err != nil {
			return "", nil, err
		}
		if n, ok := parseNumber(val); ok {
			return formatBalanceNum(sign, n, percent), getPercent(n, percent), nil
		}
		if s, ok := val.(string); ok && s != "" && !percent {
			return sign + s, nil, nil
		}
		return "", nil, fmt.Errorf("%q in response is not an amount", exprStr)
	}

	num, err := be.evalNumber()
	if err != nil {
		return "", nil, err
	}
	if math.IsInf(num, 0) || math.IsNaN(num) {
		return "", nil, errors.New("balance expression resulted in division by zero or NaN")
	}
	return formatBalanceNum(sign, num, percent), getPercent(num, percent), nil
}

func formatBalanceNum(sign string, n float64, percent bool) string {
	if percent {
		return sign + strings.TrimSuffix(strconv.FormatFloat(n*100, 'f', 1, 64), ".0") + "%"
	}
	return formatMoney(sign, n)
}

func getPercent(n float64, isPercent bool) *float64 {
	if !isPercent {
		return nil
	}
	p := n * 100
	return &p
}

type balanceExpr struct {
	src   string
	idx   int
	reply any
}

type balanceVal struct {
	n     float64
	ns    []float64
	many  bool
	items []any
}

func (e *balanceExpr) isLonePath() bool {
	return !strings.ContainsAny(e.src, "+-*/() [") && e.src != "" && !(e.src[0] >= '0' && e.src[0] <= '9')
}

func (e *balanceExpr) skipSpace() {
	for e.idx < len(e.src) && e.src[e.idx] == ' ' {
		e.idx++
	}
}

func (e *balanceExpr) evalNumber() (float64, error) {
	v, err := e.parseSum()
	if err == nil && e.idx < len(e.src) {
		err = fmt.Errorf("unexpected characters in expression: %q", e.src[e.idx:])
	}
	if err == nil && v.many {
		err = errors.New("multiple values returned where single number expected")
	}
	return v.n, err
}

func (e *balanceExpr) parseSum() (balanceVal, error) {
	v, err := e.parseProduct()
	for err == nil {
		e.skipSpace()
		if e.idx >= len(e.src) || (e.src[e.idx] != '+' && e.src[e.idx] != '-') {
			break
		}
		op := e.src[e.idx]
		e.idx++
		var w balanceVal
		if w, err = e.parseProduct(); err == nil {
			v, err = applyOp(v, w, op)
		}
	}
	return v, err
}

func (e *balanceExpr) parseProduct() (balanceVal, error) {
	v, err := e.parseUnary()
	for err == nil {
		e.skipSpace()
		if e.idx >= len(e.src) || (e.src[e.idx] != '*' && e.src[e.idx] != '/') {
			break
		}
		op := e.src[e.idx]
		e.idx++
		var w balanceVal
		if w, err = e.parseUnary(); err == nil {
			v, err = applyOp(v, w, op)
		}
	}
	return v, err
}

func applyOp(v, w balanceVal, op byte) (balanceVal, error) {
	calc := func(a, b float64) float64 {
		switch op {
		case '+':
			return a + b
		case '-':
			return a - b
		case '*':
			return a * b
		case '/':
			if b == 0 {
				return math.NaN()
			}
			return a / b
		}
		return 0
	}

	if !v.many && !w.many {
		if op == '/' && w.n == 0 {
			return v, errors.New("division by zero")
		}
		return balanceVal{n: calc(v.n, w.n)}, nil
	}

	sz := max(len(v.ns), len(w.ns))
	res := make([]float64, sz)
	for i := range res {
		a, b := v.n, w.n
		if v.many {
			a = v.ns[i]
		}
		if w.many {
			b = w.ns[i]
		}
		res[i] = calc(a, b)
	}
	return balanceVal{ns: res, many: true}, nil
}

func (e *balanceExpr) parseUnary() (balanceVal, error) {
	e.skipSpace()
	if e.idx >= len(e.src) {
		return balanceVal{}, errors.New("unexpected end of expression")
	}

	c := e.src[e.idx]
	if c == '-' {
		e.idx++
		v, err := e.parseUnary()
		if err != nil {
			return v, err
		}
		return applyOp(balanceVal{n: 0}, v, '-')
	}
	if c == '(' {
		e.idx++
		v, err := e.parseSum()
		if err != nil {
			return v, err
		}
		e.skipSpace()
		if e.idx >= len(e.src) || e.src[e.idx] != ')' {
			return v, errors.New("missing closing parenthesis ')'")
		}
		e.idx++
		return v, nil
	}

	if (c >= '0' && c <= '9') || c == '.' {
		j := e.idx
		for j < len(e.src) && ((e.src[j] >= '0' && e.src[j] <= '9') || e.src[j] == '.') {
			j++
		}
		f, err := strconv.ParseFloat(e.src[e.idx:j], 64)
		if err != nil {
			return balanceVal{}, err
		}
		e.idx = j
		return balanceVal{n: f}, nil
	}

	// Identifier or JSON path segment
	j := e.idx
	for j < len(e.src) {
		ch := e.src[j]
		if ch == '[' {
			k := strings.IndexByte(e.src[j:], ']')
			if k < 0 {
				return balanceVal{}, errors.New("missing closing bracket ']'")
			}
			j += k + 1
			continue
		}
		if ch == '*' && (j == e.idx || e.src[j-1] == '.') {
			j++
			continue
		}
		if strings.IndexByte("+-*/() ", ch) >= 0 {
			break
		}
		j++
	}

	if j == e.idx {
		return balanceVal{}, fmt.Errorf("unexpected character at %q", e.src[e.idx:])
	}

	token := e.src[e.idx:j]
	e.idx = j

	// Functions: sum, max, min, count
	if fn, isFn := balanceFuncs[token]; isFn && e.idx < len(e.src) && e.src[e.idx] == '(' {
		e.idx++
		v, err := e.parseSum()
		if err != nil {
			return v, err
		}
		e.skipSpace()
		if e.idx >= len(e.src) || e.src[e.idx] != ')' {
			return v, errors.New("missing closing parenthesis in function call")
		}
		e.idx++

		ns := v.ns
		if !v.many {
			ns = []float64{v.n}
		}
		if token == "count" && v.items != nil {
			ns = make([]float64, 0, len(v.items))
			for _, it := range v.items {
				if it != nil {
					ns = append(ns, 1)
				}
			}
		}
		val, err := fn(ns)
		return balanceVal{n: val}, err
	}

	vs, many, err := e.getAll(token)
	if err != nil {
		return balanceVal{}, err
	}

	if !many {
		n, ok := parseNumber(vs[0])
		if !ok {
			return balanceVal{}, fmt.Errorf("%q is not a number", token)
		}
		return balanceVal{n: n}, nil
	}

	ns := make([]float64, len(vs))
	for i, x := range vs {
		ns[i] = math.NaN()
		if n, ok := parseNumber(x); ok {
			ns[i] = n
		}
	}
	return balanceVal{ns: ns, many: true, items: vs}, nil
}

var balanceFuncs = map[string]func([]float64) (float64, error){
	"sum": func(ns []float64) (float64, error) {
		s := 0.0
		for _, n := range ns {
			if !math.IsNaN(n) {
				s += n
			}
		}
		return s, nil
	},
	"count": func(ns []float64) (float64, error) {
		c := 0.0
		for _, n := range ns {
			if !math.IsNaN(n) {
				c++
			}
		}
		return c, nil
	},
	"max": func(ns []float64) (float64, error) {
		best, found := 0.0, false
		for _, n := range ns {
			if !math.IsNaN(n) && (!found || n > best) {
				best, found = n, true
			}
		}
		if !found {
			return 0, errors.New("max() has no items")
		}
		return best, nil
	},
	"min": func(ns []float64) (float64, error) {
		best, found := 0.0, false
		for _, n := range ns {
			if !math.IsNaN(n) && (!found || n < best) {
				best, found = n, true
			}
		}
		if !found {
			return 0, errors.New("min() has no items")
		}
		return best, nil
	},
}

func (e *balanceExpr) getAt(path string) (any, error) {
	vs, many, err := e.getAll(path)
	if err != nil {
		return nil, err
	}
	if many {
		return nil, fmt.Errorf("%q resolved to multiple values", path)
	}
	return vs[0], nil
}

func (e *balanceExpr) getAll(path string) ([]any, bool, error) {
	path = strings.TrimPrefix(path, "$")
	segs := splitSegments(path)
	vs := []any{e.reply}
	many := false

	for _, s := range segs {
		var next []any
		for _, v := range vs {
			if v == nil {
				next = append(next, nil)
				continue
			}
			stepped := stepSegment(v, s)
			next = append(next, stepped...)
		}
		if s == "*" || strings.Contains(s, "[") {
			many = true
		}
		vs = next
		if !many && (len(vs) != 1 || vs[0] == nil) {
			return nil, false, fmt.Errorf("nothing found at %q", path)
		}
	}
	return vs, many, nil
}

func splitSegments(path string) []string {
	var segs []string
	rest := path
	for rest != "" {
		end := 0
		for end < len(rest) && rest[end] != '.' {
			if rest[end] == '[' {
				k := strings.IndexByte(rest[end:], ']')
				if k >= 0 {
					end += k
				}
			}
			end++
		}
		segs = append(segs, rest[:end])
		if end == len(rest) {
			break
		}
		rest = rest[end+1:]
	}
	return segs
}

func stepSegment(v any, seg string) []any {
	key, test, hasTest := strings.Cut(seg, "[")
	if key == "*" {
		switch x := v.(type) {
		case []any:
			return x
		case map[string]any:
			var out []any
			for _, val := range x {
				out = append(out, val)
			}
			return out
		}
		return nil
	}

	if key != "" {
		switch x := v.(type) {
		case map[string]any:
			v = x[key]
		case []any:
			if idx, err := strconv.Atoi(key); err == nil && idx >= 0 && idx < len(x) {
				v = x[idx]
			} else {
				v = nil
			}
		default:
			v = nil
		}
	}

	if !hasTest {
		return []any{v}
	}

	test = strings.TrimSuffix(test, "]")
	left, want, hasEq := strings.Cut(test, "=")
	if !hasEq {
		return []any{v}
	}

	not := false
	if strings.HasSuffix(left, "!") {
		not = true
		left = strings.TrimSuffix(left, "!")
	}
	left = strings.TrimSpace(left)
	want = strings.Trim(strings.TrimSpace(want), `'"`)

	items, ok := v.([]any)
	if !ok {
		items = []any{v}
	}

	var passed []any
	for _, it := range items {
		if it == nil {
			continue
		}
		m, ok := it.(map[string]any)
		if !ok {
			continue
		}
		got := fmt.Sprint(m[left])
		match := (got == want)
		if not {
			match = !match
		}
		if match {
			passed = append(passed, it)
		}
	}
	return passed
}
