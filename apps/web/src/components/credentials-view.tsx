import {
  Badge,
  Banner,
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

function KeysTable({ keys }: { keys: readonly ApiKeyItem[] }) {
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
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.length === 0 ? (
          <TableEmpty colSpan={6}>No keys under this device.</TableEmpty>
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
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

function DeviceCard({ grant }: { grant: DeviceGrant }) {
  const status = STATUS[grant.status];
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{grant.deviceName ?? "Unnamed device"}</CardTitle>
          <Badge tone={status.tone}>{status.label}</Badge>
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

export function CredentialsView({ result }: { result: CredentialsResult }) {
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
          devices.map((grant) => <DeviceCard key={grant.id} grant={grant} />)
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
              <KeysTable keys={keys} />
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
