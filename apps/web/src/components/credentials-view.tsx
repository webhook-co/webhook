import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
  type BadgeProps,
} from "@webhook-co/ui";
import type { ReactNode } from "react";

import type { ApiKeyItem, CredentialsResult, DeviceGrant, GrantStatus } from "@/server/credentials";

export interface CredentialsViewProps {
  result: CredentialsResult;
  /** Revoke a standalone API key. When omitted (read-only contexts) no key affordance renders. */
  onRevokeKey?: (key: ApiKeyItem) => void;
  /** Revoke a device grant (cascades to its keys). Omitted → no device affordance renders. */
  onRevokeGrant?: (grant: DeviceGrant) => void;
}

const STATUS: Record<GrantStatus, { label: string; tone: BadgeProps["tone"] }> = {
  active: { label: "active", tone: "ok" },
  pending_approval: { label: "pending", tone: "info" },
  revoked: { label: "revoked", tone: "neutral" },
  expired: { label: "expired", tone: "neutral" },
};

const METHOD: Record<DeviceGrant["authMethod"], string> = {
  device_code: "device code",
  pkce_loopback: "loopback PKCE",
};

function fmtDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : "—";
}

function keyStatus(key: ApiKeyItem): { label: string; tone: BadgeProps["tone"] } {
  // A revoked key keeps showing (audit trail) but must read as dead, not live. Expiry is
  // conveyed by the Expires column rather than a now-dependent computed status.
  return key.revokedAt ? { label: "revoked", tone: "neutral" } : { label: "active", tone: "ok" };
}

function Scopes({ scopes }: { scopes: readonly string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <Badge key={s} tone="neutral" className="font-mono text-xs">
          {s}
        </Badge>
      ))}
    </span>
  );
}

function KeysTable({
  keys,
  onRevoke,
}: {
  keys: readonly ApiKeyItem[];
  onRevoke?: (key: ApiKeyItem) => void;
}) {
  // The trailing actions column only exists when keys here are individually revocable (the
  // standalone table); device-child keys are revoked via their grant's cascade, never directly.
  const colSpan = onRevoke ? 7 : 6;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Key</TableHead>
          <TableHead>Scopes</TableHead>
          <TableHead>Last used</TableHead>
          <TableHead>Expires</TableHead>
          {onRevoke ? (
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.length === 0 ? (
          <TableEmpty colSpan={colSpan}>No keys under this device.</TableEmpty>
        ) : (
          keys.map((k) => {
            const status = keyStatus(k);
            return (
              <TableRow key={k.id}>
                <TableCell>{k.name}</TableCell>
                <TableCell>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </TableCell>
                <TableCell className="font-mono text-sm text-fg-secondary">{k.start}</TableCell>
                <TableCell>
                  <Scopes scopes={k.scopes} />
                </TableCell>
                <TableCell className="font-mono text-sm text-fg-secondary">
                  {fmtDate(k.lastUsedAt)}
                </TableCell>
                <TableCell className="font-mono text-sm text-fg-secondary">
                  {fmtDate(k.expiresAt)}
                </TableCell>
                {onRevoke ? (
                  <TableCell className="text-right">
                    {k.revokedAt ? null : (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Revoke ${k.name}`}
                        onClick={() => onRevoke(k)}
                      >
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

function DeviceCard({
  grant,
  onRevoke,
}: {
  grant: DeviceGrant;
  onRevoke?: (grant: DeviceGrant) => void;
}) {
  const status = STATUS[grant.status];
  // Only an active grant is meaningfully revocable; expired/revoked are already dead, and a
  // pending grant is approved/denied on the device, not here.
  const revocable = onRevoke && grant.status === "active";
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{grant.deviceName ?? "Unnamed device"}</CardTitle>
          <div className="flex items-center gap-3">
            <Badge tone={status.tone}>{status.label}</Badge>
            {revocable ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Revoke ${grant.deviceName ?? "device"}`}
                onClick={() => onRevoke(grant)}
              >
                Revoke
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-fg-muted">
          <span>{METHOD[grant.authMethod]}</span>
          <span>last used {fmtDate(grant.lastUsedAt)}</span>
          <span>expires {fmtDate(grant.expiresAt)}</span>
        </div>
      </CardHeader>
      <CardContent>
        <KeysTable keys={grant.keys} />
      </CardContent>
    </Card>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <Card>
      <CardContent className="py-10 text-center text-sm text-fg-muted">{children}</CardContent>
    </Card>
  );
}

export function CredentialsView({ result, onRevokeKey, onRevokeGrant }: CredentialsViewProps) {
  if (result.status === "denied") {
    return (
      <Banner tone="warn" title="Not available">
        You don&apos;t have permission to manage this organization&apos;s credentials.
      </Banner>
    );
  }
  if (result.status === "error") {
    return <Banner tone="danger">We couldn&apos;t load your credentials. Please try again.</Banner>;
  }

  const { devices, keys } = result;
  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="devices-heading" className="flex flex-col gap-4">
        <h2 id="devices-heading" className="text-lg font-semibold tracking-tight text-fg">
          Authorized devices
        </h2>
        {devices.length === 0 ? (
          <EmptyState>No authorized devices.</EmptyState>
        ) : (
          devices.map((grant) => (
            <DeviceCard key={grant.id} grant={grant} onRevoke={onRevokeGrant} />
          ))
        )}
      </section>

      <section aria-labelledby="keys-heading" className="flex flex-col gap-4">
        <h2 id="keys-heading" className="text-lg font-semibold tracking-tight text-fg">
          API keys
        </h2>
        {keys.length === 0 ? (
          <EmptyState>No API keys yet.</EmptyState>
        ) : (
          <Card>
            <CardContent className="pt-6">
              <KeysTable keys={keys} onRevoke={onRevokeKey} />
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
