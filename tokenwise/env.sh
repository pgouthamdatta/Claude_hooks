# Tokenwise exporter + Events API config — template. install.sh substitutes each
# placeholder below with the values *you* supply at install time (flags, or the matching
# $NEW_RELIC_* / $NR_* env vars), matching this org's existing `@newrelic/dev-cost init`
# CLI convention: every installer supplies and owns their own values. Nothing is baked
# into this file in the kit's own source, and no real value should ever be typed into any
# chat, PR, or commit — only passed to install.sh directly on your own machine.

# OTLP metrics/logs export — required.
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT="https://otlp.nr-data.net"
export OTEL_EXPORTER_OTLP_HEADERS="api-key=__NR_INGEST_KEY__"

# ClaudeSessionBranch (session<->branch/ticket bridge) — optional. Only set by
# install.sh if you passed --nr-account-id; the OTLP pipeline above works fully without
# it, this just adds the bridge the Dev Cost dashboard's cost-rollup query needs.
# The account id MUST be the one your own insights key is actually scoped to — a
# mismatched pair gets rejected by the Events API, confirmed live elsewhere this
# session; there's no universal correct value here, it's whatever your own key belongs
# to (check the New Relic account picker, or Account Settings -> API Keys).
export NR_ACCOUNT_ID="__NR_ACCOUNT_ID__"
export NR_INSIGHTS_API_KEY="__NR_INSIGHTS_KEY__"
# Defaults match this org's own confirmed-working setup; override if yours differs.
export NR_INSIGHTS_ENDPOINT="https://staging-insights-collector.newrelic.com"
export JIRA_BASE_URL="https://new-relic.atlassian.net/browse"
