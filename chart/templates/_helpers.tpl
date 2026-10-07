{{/*
Chart-wide helpers.

Names are prefixed with the release name so several Webers can coexist in one
namespace, which is the usual reason a chart is reusable at all.
*/}}

{{- define "weber.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "weber.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "weber.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "weber.labels" -}}
app.kubernetes.io/name: {{ include "weber.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "weber.selectorLabels" -}}
app.kubernetes.io/name: {{ include "weber.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Component names. */}}
{{- define "weber.gateway.fullname" -}}
{{- printf "%s-gateway" (include "weber.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "weber.core.fullname" -}}
{{- printf "%s-core" (include "weber.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "weber.gateway.image" -}}
{{- printf "%s:%s" .Values.gateway.image.repository (default .Chart.AppVersion .Values.gateway.image.tag) -}}
{{- end -}}

{{- define "weber.core.image" -}}
{{- printf "%s:%s" .Values.core.image.repository (default .Chart.AppVersion .Values.core.image.tag) -}}
{{- end -}}

{{- define "weber.toolchains.image" -}}
{{- printf "%s:%s" .Values.toolchains.image.repository (default .Chart.AppVersion .Values.toolchains.image.tag) -}}
{{- end -}}

{{/*
Name of the Secret holding the session key.

An operator-supplied secret is preferred over a generated one: a generated
secret is regenerated on every `helm upgrade`, which would silently invalidate
every active session.
*/}}
{{- define "weber.auth.secretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-auth" (include "weber.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* Fail fast on a configuration that would run untrusted code unauthenticated. */}}
{{- define "weber.validateAuth" -}}
{{- if and .Values.ingress.enabled (not .Values.auth.enabled) -}}
{{- fail "refusing to install: ingress.enabled requires auth.enabled. Weber executes user-supplied code, so exposing it without authentication is not a supported configuration." -}}
{{- end -}}
{{- if and .Values.auth.enabled (not .Values.auth.allowedLogins) -}}
{{- fail "auth.enabled requires auth.allowedLogins: an empty allow-list denies everyone, which is almost certainly not what you want." -}}
{{- end -}}
{{- end -}}
