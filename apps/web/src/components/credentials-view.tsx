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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ScopeSummary,
  type BadgeProps,
} from "@webhook-co/ui";
import { describeScope } from "@webhook-co/contract/scope-catalog";
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
    <Table dense>
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
                  <ScopeSummary scopes={k.scopes} describe={describeScope} />
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
      <CardContent className="py-8 text-center text-sm text-fg-muted">{children}</CardContent>
    </Card>
  );
}

/** The API-keys grouping — rendered first (above devices). `omitEmpty` drops it entirely when empty
 *  (used on the Inactive tab, where an absent grouping is quieter than an empty card). */
function KeysSection({
  keys,
  onRevoke,
  variant,
  omitEmpty = false,
}: {
  keys: readonly ApiKeyItem[];
  onRevoke?: (key: ApiKeyItem) => void;
  variant: "active" | "inactive";
  omitEmpty?: boolean;
}) {
  if (omitEmpty && keys.length === 0) return null;
  const headingId = `keys-heading-${variant}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold tracking-tight text-fg">
        API keys
      </h2>
      {keys.length === 0 ? (
        <EmptyState>No API keys yet.</EmptyState>
      ) : (
        <Card>
          <CardContent className="pt-4">
            <KeysTable keys={keys} onRevoke={onRevoke} />
          </CardContent>
        </Card>
      )}
    </section>
  );
}

/** The authorized-devices grouping — rendered below API keys. */
function DevicesSection({
  devices,
  onRevoke,
  variant,
  omitEmpty = false,
}: {
  devices: readonly DeviceGrant[];
  onRevoke?: (grant: DeviceGrant) => void;
  variant: "active" | "inactive";
  omitEmpty?: boolean;
}) {
  if (omitEmpty && devices.length === 0) return null;
  const headingId = `devices-heading-${variant}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold tracking-tight text-fg">
        Authorized devices
      </h2>
      {devices.length === 0 ? (
        <EmptyState>No authorized devices.</EmptyState>
      ) : (
        devices.map((grant) => <DeviceCard key={grant.id} grant={grant} onRevoke={onRevoke} />)
      )}
    </section>
  );
}

/** A key is dead once revoked; a grant is dead once revoked or expired (pending/active stay live). */
const isDeadKey = (k: ApiKeyItem) => k.revokedAt !== null;
const isDeadGrant = (g: DeviceGrant) => g.status === "revoked" || g.status === "expired";

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
  // Split live from dead so the default view stays compact — revoked keys + revoked/expired grants
  // move behind an "Inactive" tab (they're audit history, not something you act on). Only live
  // credentials carry a revoke affordance, so the dead groupings pass no revoke handler.
  const activeKeys = keys.filter((k) => !isDeadKey(k));
  const inactiveKeys = keys.filter(isDeadKey);
  const activeDevices = devices.filter((g) => !isDeadGrant(g));
  const inactiveDevices = devices.filter(isDeadGrant);
  const inactiveCount = inactiveKeys.length + inactiveDevices.length;

  return (
    <Tabs defaultValue="active" className="flex flex-col gap-6">
      <TabsList aria-label="Credential status">
        <TabsTrigger value="active">Active</TabsTrigger>
        <TabsTrigger value="inactive">
          Inactive{inactiveCount > 0 ? ` (${inactiveCount})` : ""}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="active">
        <div className="flex flex-col gap-8">
          <KeysSection keys={activeKeys} onRevoke={onRevokeKey} variant="active" />
          <DevicesSection devices={activeDevices} onRevoke={onRevokeGrant} variant="active" />
        </div>
      </TabsContent>

      <TabsContent value="inactive">
        {inactiveCount === 0 ? (
          <EmptyState>No revoked or expired credentials.</EmptyState>
        ) : (
          <div className="flex flex-col gap-8">
            <KeysSection keys={inactiveKeys} variant="inactive" omitEmpty />
            <DevicesSection devices={inactiveDevices} variant="inactive" omitEmpty />
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
