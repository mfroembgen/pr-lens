{{- define "pr-lens.fullname" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "pr-lens.selectorLabels" -}}
app.kubernetes.io/name: pr-lens
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
