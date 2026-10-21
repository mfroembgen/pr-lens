# PR Lens Helm chart

Run the durable canvas server with one replica and SQLite on a retained PVC.
The image and chart are released together; chart `0.1.1` uses
`ghcr.io/mfroembgen/pr-lens:v0.1.1`.

Create a Kubernetes Secret through your secret manager with a `token` key holding
32 random bytes encoded as 64 lowercase hexadecimal characters. Set
`existingSecret` to its name. Keep that publishing credential out of values files.

```yaml
existingSecret: pr-lens
publicOrigin: https://pr-lens.example.com
gitlabOrigin: https://gitlab.example.com
ingress:
  enabled: true
  className: traefik
  host: pr-lens.example.com
  tls:
    - secretName: pr-lens-tls
      hosts:
        - pr-lens.example.com
persistence:
  storageClassName: standard
  size: 1Gi
```

```bash
helm upgrade --install pr-lens oci://ghcr.io/mfroembgen/charts/pr-lens \
  --version 0.1.1 --namespace pr-lens --create-namespace -f values.yaml
```

`publicOrigin` must match the HTTPS viewer origin. With `gitlabOrigin` configured,
each canvas is bound to a GitLab project and readers need repository access to
that project. Publishers send their own GitLab credential; the chart does not
provision a shared GitLab service token. Omitting `gitlabOrigin` disables this
project check, so restrict access at your ingress when using that mode.

The server listens on port 8080. The pod runs as UID/GID 1000 without a service
account token, capabilities, privilege escalation, or a writable root filesystem.
`/tmp` has a 64 MiB temporary volume. SQLite uses `/data/pr-lens.sqlite`.
Keep one replica: `Recreate` updates avoid concurrent SQLite writers.
The server rejects request bodies over 4,000,000 bytes.
It sends a same-origin Content Security Policy, `nosniff`, and a `no-referrer`
policy; SVG responses also use a sandbox policy.

The chart retains its PVC when Helm removes the release. Set
`persistence.existingClaim` to reuse a separately managed claim. Retention does
not protect against direct PVC or namespace deletion; back up the database before
those operations. Disable persistence only for disposable tests; that mode loses
all canvases when the pod is replaced.

`networkPolicy.enabled` defaults to false. When enabled, both ingress and egress
are denied unless allowed by the supplied `networkPolicy.ingress` and
`networkPolicy.egress` rules. Allow ingress from your ingress controller, DNS,
and HTTPS to GitLab when project authentication is enabled. Standard Kubernetes
NetworkPolicy cannot select a DNS hostname; use current destination CIDRs or
your network provider's hostname policy where available.

Verify with `helm lint charts/pr-lens` and representative `helm template` renders
before deployment. After deployment, check `/healthz`, project access, a canvas
update, and reopening that canvas after a pod restart.
