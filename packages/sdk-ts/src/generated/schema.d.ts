// GENERATED FILE — DO NOT EDIT.
// Source: packages/openapi/src/openapi.json (the golden OpenAPI 3.1 document).
// Regenerate: pnpm --filter @webhook-co/sdk generate

export interface paths {
    "/v1/audit/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Verify the org's tamper-evident audit chain */
        post: operations["auditVerify"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/deliveries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List outbound delivery attempts */
        get: operations["deliveriesList"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/deliveries/{deliveryId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a delivery attempt */
        get: operations["deliveriesGet"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/endpoints": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List endpoints */
        get: operations["endpointsList"];
        put?: never;
        /** Create an endpoint (returns the one-time ingest URL) */
        post: operations["endpointsCreate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/endpoints/{endpointId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an endpoint */
        get: operations["endpointsGet"];
        put?: never;
        post?: never;
        /** Soft-delete an endpoint (idempotent) */
        delete: operations["endpointsDelete"];
        options?: never;
        head?: never;
        /** Update an endpoint's deduplication config (null resets to the default) */
        patch: operations["endpointsUpdate"];
        trace?: never;
    };
    "/v1/endpoints/{endpointId}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List captured events for an endpoint */
        get: operations["eventsList"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/endpoints/{endpointId}/events/tail": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Pull a watermark-bounded forward page of events (cursor-pull tail) */
        get: operations["eventsTail"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/endpoints/{endpointId}/provider-secrets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List an endpoint's provider secrets (metadata only) */
        get: operations["endpointsListProviderSecrets"];
        put?: never;
        /** Add a provider signing/verification secret to an endpoint */
        post: operations["endpointsAddProviderSecret"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/endpoints/{endpointId}/provider-secrets/{secretId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Revoke a provider secret */
        delete: operations["endpointsRevokeProviderSecret"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/endpoints/{endpointId}/reveal-ingest-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reveal an endpoint's always-shown ingest URL */
        post: operations["endpointsRevealIngestUrl"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/endpoints/{endpointId}/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Rotate an endpoint's ingest token (returns a new one-time ingest URL) */
        post: operations["endpointsRotate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/events/{eventId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a captured event */
        get: operations["eventsGet"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/events/{eventId}/payload": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a captured event's raw payload (base64 envelope) */
        get: operations["eventsGetPayload"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/events/{eventId}/replay": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Replay an event to a target (records a delivery attempt) */
        post: operations["eventsReplay"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/replay-destinations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List replay destinations (the SSRF-egress allowlist) */
        get: operations["replayDestinationsList"];
        put?: never;
        /** Register a replay destination (returns a one-time signing secret) */
        post: operations["replayDestinationsCreate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/replay-destinations/{destinationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Soft-delete a replay destination */
        delete: operations["replayDestinationsDelete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/replay-destinations/{destinationId}/enable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Re-enable an auto-disabled replay destination */
        post: operations["replayDestinationsEnable"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/replay-destinations/{destinationId}/ordered": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Toggle strict-FIFO delivery for a destination */
        post: operations["replayDestinationsSetOrdered"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/replay-destinations/{destinationId}/signing-secret": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Rotate a destination's signing secret (returns the new one-time secret) */
        post: operations["replayDestinationsRotateSigningSecret"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/replay-destinations/{destinationId}/signing-secrets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List a destination's signing-secret metadata */
        get: operations["replayDestinationsListSigningSecrets"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/subscriptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List auto-delivery subscriptions */
        get: operations["subscriptionsList"];
        put?: never;
        /** Create (upsert) an auto-delivery subscription */
        post: operations["subscriptionsCreate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/subscriptions/{subscriptionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete an auto-delivery subscription */
        delete: operations["subscriptionsDelete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/triggers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List agent trigger subscriptions */
        get: operations["triggersList"];
        put?: never;
        /** Create an agent trigger subscription */
        post: operations["triggersCreate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/triggers/{triggerId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Revoke an agent trigger subscription */
        delete: operations["triggersRevoke"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/whoami": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Return the authenticated principal (org, scopes, optional user) */
        get: operations["whoami"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        AddedProviderSecret: {
            /** Format: uuid */
            id: string;
            provider: components["schemas"]["Provider"];
            /** @enum {string} */
            status: "active" | "retiring" | "revoked";
        };
        AuditVerifyResponse: {
            /** @constant */
            ok: true;
            rowsVerified: number;
        } | {
            break: {
                detail: string;
                /** @enum {string} */
                kind: "wrong_org" | "bad_genesis_seq" | "bad_genesis_prev_hash" | "duplicate_seq" | "seq_gap" | "broken_link" | "hash_mismatch";
                seq: number;
            };
            /** @constant */
            ok: false;
            rowsVerified: number;
        };
        AuthContext: {
            orgId: string;
            scopes: string[];
            userId?: string;
        };
        CreatedEndpoint: {
            /** Format: date-time */
            createdAt: string;
            /** @default null */
            dedupConfig: {
                fields?: {
                    exclude?: string[];
                    include: string[];
                };
                /** @enum {string} */
                mode: "identifier" | "content" | "fields" | "off";
                windowSeconds?: number;
            } | null;
            /** Format: uuid */
            id: string;
            /** Format: uri */
            ingestUrl: string;
            name: string;
            /** Format: uuid */
            orgId: string;
            paused: boolean;
        };
        CreatedReplayDestination: {
            /** Format: date-time */
            createdAt: string;
            disabledAt: string | null;
            /** Format: uuid */
            id: string;
            label: string | null;
            lastValidatedAt: string | null;
            ordered: boolean;
            /** Format: uuid */
            orgId: string;
            signingSecret?: string;
            /** @enum {string} */
            status: "active" | "revoked";
            url: string;
        };
        DeletedEndpoint: {
            /** Format: date-time */
            deletedAt: string;
            /** Format: uuid */
            id: string;
        };
        DeliveriesListResponse: {
            items: components["schemas"]["Delivery"][];
            nextCursor: string | null;
        };
        Delivery: {
            attempt: number;
            /** Format: date-time */
            createdAt: string;
            destinationId: string | null;
            error: string | null;
            /** Format: uuid */
            eventId: string;
            /** Format: uuid */
            id: string;
            nextRetryAt: string | null;
            sourceVerificationState: components["schemas"]["VerificationState"];
            status: components["schemas"]["DeliveryStatus"];
            statusCode: number | null;
            subscriptionId: string | null;
        };
        DeliveryAttempt: {
            attempt: number;
            /** Format: date-time */
            createdAt: string;
            error: string | null;
            /** Format: uuid */
            eventId: string;
            /** Format: uuid */
            id: string;
            idempotencyKey: string | null;
            /** Format: uuid */
            orgId: string;
            status: components["schemas"]["DeliveryStatus"];
            statusCode: number | null;
            target: string;
        };
        /** @enum {string} */
        DeliveryStatus: "queued" | "forwarded" | "pending" | "delivered" | "failed" | "blocked" | "dead" | "cancelled";
        Endpoint: {
            /** Format: date-time */
            createdAt: string;
            /** @default null */
            dedupConfig: {
                fields?: {
                    exclude?: string[];
                    include: string[];
                };
                /** @enum {string} */
                mode: "identifier" | "content" | "fields" | "off";
                windowSeconds?: number;
            } | null;
            /** Format: uuid */
            id: string;
            name: string;
            /** Format: uuid */
            orgId: string;
            paused: boolean;
        };
        /** @description The server additionally validates the secret shape per provider (e.g. a Standard-Webhooks secret must be base64 key material); a malformed value is rejected with 400 VALIDATION_ERROR. */
        EndpointsAddProviderSecretRequest: {
            /**
             * @default signing_secret
             * @enum {string}
             */
            kind: "signing_secret" | "verify_token" | "braintree_public_key";
            label?: string;
            /** @enum {string} */
            provider: "stripe" | "github" | "shopify" | "slack" | "standard_webhooks" | "clerk" | "resend" | "stytch" | "supabase" | "render" | "brex" | "openai" | "replicate" | "polar" | "gemini" | "incident_io" | "etsy" | "vanta" | "pusher" | "quickbooks" | "chargify" | "launchdarkly" | "modern_treasury" | "autodesk_aps" | "mongodb_atlas" | "xero" | "segment" | "aftership" | "onfleet" | "webflow" | "klaviyo" | "mux" | "shippo" | "buildkite" | "ms_teams" | "ably" | "squarespace" | "nylas" | "linkedin" | "tiktok" | "airship" | "lob" | "persona" | "bolt" | "primer" | "airwallex" | "affirm" | "keygen" | "constant_contact" | "telegram" | "mixpanel" | "new_relic" | "fillout" | "zapier" | "tally" | "loops" | "customer_io" | "framer" | "box" | "configcat" | "ashby" | "merge_dev" | "cronofy" | "increase" | "finch" | "knock" | "deel" | "razorpay" | "sentry" | "linear" | "dropbox" | "checkout_com" | "lemon_squeezy" | "coinbase_commerce" | "dwolla" | "gocardless" | "notion" | "meta" | "woocommerce" | "bitbucket" | "atlassian_jira" | "x" | "clickup" | "npm" | "heroku" | "dub" | "cal_com" | "asana" | "circleci" | "pagerduty" | "airtable" | "calendly" | "zoom" | "customerio" | "sinch" | "workos" | "front" | "zendesk" | "twitch" | "paddle" | "recurly" | "docusign" | "vercel" | "intercom" | "paystack" | "authorize_net" | "sanity" | "square" | "trello" | "twilio" | "mandrill" | "hubspot" | "adyen" | "mailgun" | "mercado_pago" | "braintree" | "contentful" | "plivo" | "typeform" | "messagebird" | "netlify" | "vonage" | "monday" | "jira_connect" | "discord" | "telnyx" | "sendgrid" | "wise" | "kinde" | "paypal" | "aws_sns" | "plaid" | "ebay" | "gitlab" | "microsoft_graph" | "chargebee" | "postmark" | "sparkpost" | "okta" | "bigcommerce" | "datadog" | "brevo";
            secret: string;
        };
        EndpointsCreateRequest: {
            dedupConfig?: {
                fields?: {
                    exclude?: string[];
                    include: string[];
                };
                /** @enum {string} */
                mode: "identifier" | "content" | "fields" | "off";
                windowSeconds?: number;
            } | null;
            name: string;
        };
        EndpointsListProviderSecretsResponse: {
            items: components["schemas"]["ProviderSecretSummary"][];
        };
        EndpointsListResponse: {
            items: components["schemas"]["Endpoint"][];
            nextCursor: string | null;
        };
        EndpointsRevealIngestUrlResponse: {
            ingestUrl: string | null;
        };
        EndpointsUpdateRequest: {
            dedupConfig: {
                fields?: {
                    exclude?: string[];
                    include: string[];
                };
                /** @enum {string} */
                mode: "identifier" | "content" | "fields" | "off";
                windowSeconds?: number;
            } | null;
        };
        /** @description The JSON error envelope for capability faults. */
        Error: {
            /** @description A stable capability-error code. */
            error: string;
            /** @description A human-readable description. */
            message: string;
        };
        Event: {
            contentType: string | null;
            dedupKey: string;
            /** @enum {string} */
            dedupStrategy: "sw_webhook_id" | "provider_event_id" | "content_hash" | "fields" | "unique";
            /** Format: uuid */
            endpointId: string;
            externalId: string | null;
            headers: [
                string,
                string
            ][];
            /** Format: uuid */
            id: string;
            method?: string | null;
            /** Format: uuid */
            orgId: string;
            payloadBytes: number;
            payloadR2Key: string;
            provider: components["schemas"]["Provider"] | null;
            providerEventId: string | null;
            /** Format: date-time */
            receivedAt: string;
            verification: components["schemas"]["VerificationResult"] | null;
            verificationState?: components["schemas"]["VerificationState"];
            verified: boolean;
        };
        EventsGetPayloadResponse: {
            bodyBase64: string;
            bytes: number;
            contentType: string | null;
        };
        EventsListResponse: {
            headCursor?: string | null;
            items: components["schemas"]["EventSummary"][];
            nextCursor: string | null;
        };
        EventsReplayRequest: {
            idempotencyKey: string;
            target: {
                /** @constant */
                kind: "localhost-tunnel";
                sessionId: string;
            } | {
                /** Format: uuid */
                destinationId: string;
                /** @constant */
                kind: "destination";
            };
        };
        EventsTailResponse: {
            caughtUp?: boolean;
            headCursor?: string | null;
            items: components["schemas"]["EventSummary"][];
            lag?: {
                backlogCount: number;
                headLagMs?: number;
            };
            nextCursor: string | null;
        };
        EventSummary: {
            dedupKey: string;
            /** @enum {string} */
            dedupStrategy: "sw_webhook_id" | "provider_event_id" | "content_hash" | "fields" | "unique";
            /** Format: uuid */
            endpointId: string;
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            orgId: string;
            provider: components["schemas"]["Provider"] | null;
            /** Format: date-time */
            receivedAt: string;
            verificationState?: components["schemas"]["VerificationState"];
            verified: boolean;
        };
        /** @enum {string} */
        Provider: "stripe" | "github" | "shopify" | "slack" | "standard_webhooks" | "clerk" | "resend" | "stytch" | "supabase" | "render" | "brex" | "openai" | "replicate" | "polar" | "gemini" | "incident_io" | "etsy" | "vanta" | "pusher" | "quickbooks" | "chargify" | "launchdarkly" | "modern_treasury" | "autodesk_aps" | "mongodb_atlas" | "xero" | "segment" | "aftership" | "onfleet" | "webflow" | "klaviyo" | "mux" | "shippo" | "buildkite" | "ms_teams" | "ably" | "squarespace" | "nylas" | "linkedin" | "tiktok" | "airship" | "lob" | "persona" | "bolt" | "primer" | "airwallex" | "affirm" | "keygen" | "constant_contact" | "telegram" | "mixpanel" | "new_relic" | "fillout" | "zapier" | "tally" | "loops" | "customer_io" | "framer" | "box" | "configcat" | "ashby" | "merge_dev" | "cronofy" | "increase" | "finch" | "knock" | "deel" | "razorpay" | "sentry" | "linear" | "dropbox" | "checkout_com" | "lemon_squeezy" | "coinbase_commerce" | "dwolla" | "gocardless" | "notion" | "meta" | "woocommerce" | "bitbucket" | "atlassian_jira" | "x" | "clickup" | "npm" | "heroku" | "dub" | "cal_com" | "asana" | "circleci" | "pagerduty" | "airtable" | "calendly" | "zoom" | "customerio" | "sinch" | "workos" | "front" | "zendesk" | "twitch" | "paddle" | "recurly" | "docusign" | "vercel" | "intercom" | "paystack" | "authorize_net" | "sanity" | "square" | "trello" | "twilio" | "mandrill" | "hubspot" | "adyen" | "mailgun" | "mercado_pago" | "braintree" | "contentful" | "plivo" | "typeform" | "messagebird" | "netlify" | "vonage" | "monday" | "jira_connect" | "discord" | "telnyx" | "sendgrid" | "wise" | "kinde" | "paypal" | "aws_sns" | "plaid" | "ebay" | "gitlab" | "microsoft_graph" | "chargebee" | "postmark" | "sparkpost" | "okta" | "bigcommerce" | "datadog" | "brevo";
        ProviderSecretSummary: {
            /** Format: date-time */
            createdAt: string;
            /** Format: uuid */
            id: string;
            label: string | null;
            provider: components["schemas"]["Provider"];
            /** @enum {string} */
            status: "active" | "retiring" | "revoked";
        };
        ReplayDestination: {
            /** Format: date-time */
            createdAt: string;
            disabledAt: string | null;
            /** Format: uuid */
            id: string;
            label: string | null;
            lastValidatedAt: string | null;
            ordered: boolean;
            /** Format: uuid */
            orgId: string;
            /** @enum {string} */
            status: "active" | "revoked";
            url: string;
        };
        ReplayDestinationDeleted: {
            /** Format: date-time */
            deletedAt: string;
            /** Format: uuid */
            id: string;
        };
        /** @description `url` must be a public HTTPS URL (no IP-literal host, credentials, disallowed port, or bare hostname); the server rejects a non-conforming URL with 400 VALIDATION_ERROR. */
        ReplayDestinationsCreateRequest: {
            label?: string;
            url: string;
        };
        ReplayDestinationsListResponse: {
            items: components["schemas"]["ReplayDestination"][];
        };
        ReplayDestinationsListSigningSecretsResponse: {
            items: components["schemas"]["SigningSecretMetadata"][];
        };
        ReplayDestinationsSetOrderedRequest: {
            ordered: boolean;
        };
        RevokedProviderSecret: {
            /** Format: uuid */
            id: string;
            /** Format: date-time */
            revokedAt: string;
        };
        RotatedSigningSecret: {
            /** Format: uuid */
            destinationId: string;
            /** Format: uuid */
            keyId: string;
            signingSecret: string;
        };
        SigningSecretMetadata: {
            /** Format: date-time */
            createdAt: string;
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            status: "active" | "retiring" | "revoked";
        };
        Subscription: {
            /** Format: date-time */
            createdAt: string;
            /** Format: uuid */
            destinationId: string;
            enabled: boolean;
            eventTypes: string[];
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            orgId: string;
            provider: string | null;
            requireVerified: boolean;
            /** Format: uuid */
            sourceEndpointId: string;
            /** Format: date-time */
            updatedAt: string;
        };
        SubscriptionDeleted: {
            /** Format: uuid */
            id: string;
        };
        SubscriptionsCreateRequest: {
            /** Format: uuid */
            destinationId: string;
            eventTypes?: string[];
            provider?: string | null;
            requireVerified?: boolean;
            /** Format: uuid */
            sourceEndpointId: string;
        };
        SubscriptionsListResponse: {
            items: components["schemas"]["Subscription"][];
        };
        TriggersCreateRequest: {
            /** Format: uuid */
            endpointId: string;
            name?: string;
        };
        TriggersCreateResponse: {
            /** Format: date-time */
            createdAt: string;
            /** Format: uuid */
            endpointId: string;
            /** Format: uuid */
            id: string;
            name: string | null;
            /** Format: uuid */
            orgId: string;
            revokedAt: string | null;
        };
        TriggersListResponse: {
            items: components["schemas"]["TriggersCreateResponse"][];
        };
        TriggersRevokeResponse: {
            /** Format: uuid */
            id: string;
        };
        VerificationResult: {
            /** @enum {string} */
            authenticity?: "token" | "basic";
            keyId: string;
            /** @constant */
            ok: true;
            /** @enum {string} */
            scheme: "stripe" | "github" | "shopify" | "slack" | "standard_webhooks" | "clerk" | "resend" | "stytch" | "supabase" | "render" | "brex" | "openai" | "replicate" | "polar" | "gemini" | "incident_io" | "etsy" | "vanta" | "pusher" | "quickbooks" | "chargify" | "launchdarkly" | "modern_treasury" | "autodesk_aps" | "mongodb_atlas" | "xero" | "segment" | "aftership" | "onfleet" | "webflow" | "klaviyo" | "mux" | "shippo" | "buildkite" | "ms_teams" | "ably" | "squarespace" | "nylas" | "linkedin" | "tiktok" | "airship" | "lob" | "persona" | "bolt" | "primer" | "airwallex" | "affirm" | "keygen" | "constant_contact" | "telegram" | "mixpanel" | "new_relic" | "fillout" | "zapier" | "tally" | "loops" | "customer_io" | "framer" | "box" | "configcat" | "ashby" | "merge_dev" | "cronofy" | "increase" | "finch" | "knock" | "deel" | "razorpay" | "sentry" | "linear" | "dropbox" | "checkout_com" | "lemon_squeezy" | "coinbase_commerce" | "dwolla" | "gocardless" | "notion" | "meta" | "woocommerce" | "bitbucket" | "atlassian_jira" | "x" | "clickup" | "npm" | "heroku" | "dub" | "cal_com" | "asana" | "circleci" | "pagerduty" | "airtable" | "calendly" | "zoom" | "customerio" | "sinch" | "workos" | "front" | "zendesk" | "twitch" | "paddle" | "recurly" | "docusign" | "vercel" | "intercom" | "paystack" | "authorize_net" | "sanity" | "square" | "trello" | "twilio" | "mandrill" | "hubspot" | "adyen" | "mailgun" | "mercado_pago" | "braintree" | "contentful" | "plivo" | "typeform" | "messagebird" | "netlify" | "vonage" | "monday" | "jira_connect" | "discord" | "telnyx" | "sendgrid" | "wise" | "kinde" | "paypal" | "aws_sns" | "plaid" | "ebay" | "gitlab" | "microsoft_graph" | "chargebee" | "postmark" | "sparkpost" | "okta" | "bigcommerce" | "datadog" | "brevo" | "unknown";
        } | {
            /** @constant */
            ok: false;
            reason: {
                /** @constant */
                code: "MISSING_HEADER";
                header: string;
                /** @enum {string} */
                scheme: "stripe" | "github" | "shopify" | "slack" | "standard_webhooks" | "clerk" | "resend" | "stytch" | "supabase" | "render" | "brex" | "openai" | "replicate" | "polar" | "gemini" | "incident_io" | "etsy" | "vanta" | "pusher" | "quickbooks" | "chargify" | "launchdarkly" | "modern_treasury" | "autodesk_aps" | "mongodb_atlas" | "xero" | "segment" | "aftership" | "onfleet" | "webflow" | "klaviyo" | "mux" | "shippo" | "buildkite" | "ms_teams" | "ably" | "squarespace" | "nylas" | "linkedin" | "tiktok" | "airship" | "lob" | "persona" | "bolt" | "primer" | "airwallex" | "affirm" | "keygen" | "constant_contact" | "telegram" | "mixpanel" | "new_relic" | "fillout" | "zapier" | "tally" | "loops" | "customer_io" | "framer" | "box" | "configcat" | "ashby" | "merge_dev" | "cronofy" | "increase" | "finch" | "knock" | "deel" | "razorpay" | "sentry" | "linear" | "dropbox" | "checkout_com" | "lemon_squeezy" | "coinbase_commerce" | "dwolla" | "gocardless" | "notion" | "meta" | "woocommerce" | "bitbucket" | "atlassian_jira" | "x" | "clickup" | "npm" | "heroku" | "dub" | "cal_com" | "asana" | "circleci" | "pagerduty" | "airtable" | "calendly" | "zoom" | "customerio" | "sinch" | "workos" | "front" | "zendesk" | "twitch" | "paddle" | "recurly" | "docusign" | "vercel" | "intercom" | "paystack" | "authorize_net" | "sanity" | "square" | "trello" | "twilio" | "mandrill" | "hubspot" | "adyen" | "mailgun" | "mercado_pago" | "braintree" | "contentful" | "plivo" | "typeform" | "messagebird" | "netlify" | "vonage" | "monday" | "jira_connect" | "discord" | "telnyx" | "sendgrid" | "wise" | "kinde" | "paypal" | "aws_sns" | "plaid" | "ebay" | "gitlab" | "microsoft_graph" | "chargebee" | "postmark" | "sparkpost" | "okta" | "bigcommerce" | "datadog" | "brevo" | "unknown";
            } | {
                /** @constant */
                code: "MALFORMED_SIGNATURE";
                detail: string;
                /** @enum {string} */
                scheme: "stripe" | "github" | "shopify" | "slack" | "standard_webhooks" | "clerk" | "resend" | "stytch" | "supabase" | "render" | "brex" | "openai" | "replicate" | "polar" | "gemini" | "incident_io" | "etsy" | "vanta" | "pusher" | "quickbooks" | "chargify" | "launchdarkly" | "modern_treasury" | "autodesk_aps" | "mongodb_atlas" | "xero" | "segment" | "aftership" | "onfleet" | "webflow" | "klaviyo" | "mux" | "shippo" | "buildkite" | "ms_teams" | "ably" | "squarespace" | "nylas" | "linkedin" | "tiktok" | "airship" | "lob" | "persona" | "bolt" | "primer" | "airwallex" | "affirm" | "keygen" | "constant_contact" | "telegram" | "mixpanel" | "new_relic" | "fillout" | "zapier" | "tally" | "loops" | "customer_io" | "framer" | "box" | "configcat" | "ashby" | "merge_dev" | "cronofy" | "increase" | "finch" | "knock" | "deel" | "razorpay" | "sentry" | "linear" | "dropbox" | "checkout_com" | "lemon_squeezy" | "coinbase_commerce" | "dwolla" | "gocardless" | "notion" | "meta" | "woocommerce" | "bitbucket" | "atlassian_jira" | "x" | "clickup" | "npm" | "heroku" | "dub" | "cal_com" | "asana" | "circleci" | "pagerduty" | "airtable" | "calendly" | "zoom" | "customerio" | "sinch" | "workos" | "front" | "zendesk" | "twitch" | "paddle" | "recurly" | "docusign" | "vercel" | "intercom" | "paystack" | "authorize_net" | "sanity" | "square" | "trello" | "twilio" | "mandrill" | "hubspot" | "adyen" | "mailgun" | "mercado_pago" | "braintree" | "contentful" | "plivo" | "typeform" | "messagebird" | "netlify" | "vonage" | "monday" | "jira_connect" | "discord" | "telnyx" | "sendgrid" | "wise" | "kinde" | "paypal" | "aws_sns" | "plaid" | "ebay" | "gitlab" | "microsoft_graph" | "chargebee" | "postmark" | "sparkpost" | "okta" | "bigcommerce" | "datadog" | "brevo" | "unknown";
            } | {
                /** @constant */
                code: "UNSUPPORTED_SCHEME";
                observedHeaders: string[];
            } | {
                /** @constant */
                code: "KEY_FETCH_FAILED";
                /** @enum {string} */
                scheme: "stripe" | "github" | "shopify" | "slack" | "standard_webhooks" | "clerk" | "resend" | "stytch" | "supabase" | "render" | "brex" | "openai" | "replicate" | "polar" | "gemini" | "incident_io" | "etsy" | "vanta" | "pusher" | "quickbooks" | "chargify" | "launchdarkly" | "modern_treasury" | "autodesk_aps" | "mongodb_atlas" | "xero" | "segment" | "aftership" | "onfleet" | "webflow" | "klaviyo" | "mux" | "shippo" | "buildkite" | "ms_teams" | "ably" | "squarespace" | "nylas" | "linkedin" | "tiktok" | "airship" | "lob" | "persona" | "bolt" | "primer" | "airwallex" | "affirm" | "keygen" | "constant_contact" | "telegram" | "mixpanel" | "new_relic" | "fillout" | "zapier" | "tally" | "loops" | "customer_io" | "framer" | "box" | "configcat" | "ashby" | "merge_dev" | "cronofy" | "increase" | "finch" | "knock" | "deel" | "razorpay" | "sentry" | "linear" | "dropbox" | "checkout_com" | "lemon_squeezy" | "coinbase_commerce" | "dwolla" | "gocardless" | "notion" | "meta" | "woocommerce" | "bitbucket" | "atlassian_jira" | "x" | "clickup" | "npm" | "heroku" | "dub" | "cal_com" | "asana" | "circleci" | "pagerduty" | "airtable" | "calendly" | "zoom" | "customerio" | "sinch" | "workos" | "front" | "zendesk" | "twitch" | "paddle" | "recurly" | "docusign" | "vercel" | "intercom" | "paystack" | "authorize_net" | "sanity" | "square" | "trello" | "twilio" | "mandrill" | "hubspot" | "adyen" | "mailgun" | "mercado_pago" | "braintree" | "contentful" | "plivo" | "typeform" | "messagebird" | "netlify" | "vonage" | "monday" | "jira_connect" | "discord" | "telnyx" | "sendgrid" | "wise" | "kinde" | "paypal" | "aws_sns" | "plaid" | "ebay" | "gitlab" | "microsoft_graph" | "chargebee" | "postmark" | "sparkpost" | "okta" | "bigcommerce" | "datadog" | "brevo" | "unknown";
            } | {
                /** @constant */
                code: "TIMESTAMP_TOO_OLD";
                skewSeconds: number;
                toleranceSeconds: number;
            } | {
                /** @constant */
                code: "TIMESTAMP_IN_FUTURE";
                skewSeconds: number;
                toleranceSeconds: number;
            } | {
                /** @constant */
                code: "NO_MATCHING_KEY";
                keysTried: number;
            } | {
                /** @constant */
                code: "WRONG_SECRET";
                /** @enum {string} */
                confidence: "low" | "medium";
            } | {
                /** @constant */
                code: "RAW_BODY_MODIFIED";
                /** @enum {string} */
                confidence: "low" | "medium";
                /** @enum {string} */
                evidence?: "trailing_whitespace" | "reencoded_json";
            } | {
                /** @constant */
                code: "PROXY_MUTATED_BYTES";
                /** @enum {string} */
                confidence: "low" | "medium";
            } | {
                /** @constant */
                code: "SIGNATURE_MISMATCH";
            };
        };
        /** @enum {string} */
        VerificationState: "verified" | "authenticated" | "failed" | "unattempted";
    };
    responses: {
        /** @description The delivery target was unreachable. */
        BadGateway: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description The request failed validation. */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description The request conflicts with the resource's current state. */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description The credential is valid but lacks the required scope. Empty body; WWW-Authenticate carries the challenge. */
        Forbidden: {
            headers: {
                /** @description RFC 6750 Bearer challenge. */
                "WWW-Authenticate"?: string;
                [name: string]: unknown;
            };
            content?: never;
        };
        /** @description An unexpected server error. The body is a plain-text sentinel. */
        InternalError: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "text/plain": string;
            };
        };
        /** @description The referenced resource was not found. */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description A rate limit or soft cap was exceeded. */
        TooManyRequests: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Missing or invalid bearer credential. Empty body; the WWW-Authenticate header carries the challenge. */
        Unauthorized: {
            headers: {
                /** @description RFC 6750 Bearer challenge. */
                "WWW-Authenticate"?: string;
                [name: string]: unknown;
            };
            content?: never;
        };
    };
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    auditVerify: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditVerifyResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    deliveriesList: {
        parameters: {
            query?: {
                /** @description Opaque keyset cursor from a prior page's nextCursor. */
                cursor?: string;
                /** @description Filter by destination (empty = no filter). */
                destinationId?: string;
                /** @description Max items to return (1–200, default 50). */
                limit?: number;
                /** @description Filter by delivery status (repeatable). */
                status?: ("queued" | "forwarded" | "pending" | "delivered" | "failed" | "blocked" | "dead" | "cancelled")[];
                /** @description Filter by subscription (empty = no filter). */
                subscriptionId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveriesListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    deliveriesGet: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                deliveryId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Delivery"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    endpointsList: {
        parameters: {
            query?: {
                /** @description Opaque keyset cursor from a prior page's nextCursor. */
                cursor?: string;
                /** @description Max items to return (1–200, default 50). */
                limit?: number;
                /** @description Case-insensitive substring name filter (empty = no filter). */
                name?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EndpointsListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    endpointsCreate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EndpointsCreateRequest"];
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreatedEndpoint"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    endpointsGet: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                endpointId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Endpoint"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    endpointsDelete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                endpointId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeletedEndpoint"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    endpointsUpdate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                endpointId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EndpointsUpdateRequest"];
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Endpoint"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    eventsList: {
        parameters: {
            query?: {
                /** @description Opaque keyset cursor from a prior page's nextCursor. */
                cursor?: string;
                /** @description Max items to return (1–200, default 50). */
                limit?: number;
                /** @description Filter by provider (repeatable). */
                provider?: ("stripe" | "github" | "shopify" | "slack" | "standard_webhooks" | "clerk" | "resend" | "stytch" | "supabase" | "render" | "brex" | "openai" | "replicate" | "polar" | "gemini" | "incident_io" | "etsy" | "vanta" | "pusher" | "quickbooks" | "chargify" | "launchdarkly" | "modern_treasury" | "autodesk_aps" | "mongodb_atlas" | "xero" | "segment" | "aftership" | "onfleet" | "webflow" | "klaviyo" | "mux" | "shippo" | "buildkite" | "ms_teams" | "ably" | "squarespace" | "nylas" | "linkedin" | "tiktok" | "airship" | "lob" | "persona" | "bolt" | "primer" | "airwallex" | "affirm" | "keygen" | "constant_contact" | "telegram" | "mixpanel" | "new_relic" | "fillout" | "zapier" | "tally" | "loops" | "customer_io" | "framer" | "box" | "configcat" | "ashby" | "merge_dev" | "cronofy" | "increase" | "finch" | "knock" | "deel" | "razorpay" | "sentry" | "linear" | "dropbox" | "checkout_com" | "lemon_squeezy" | "coinbase_commerce" | "dwolla" | "gocardless" | "notion" | "meta" | "woocommerce" | "bitbucket" | "atlassian_jira" | "x" | "clickup" | "npm" | "heroku" | "dub" | "cal_com" | "asana" | "circleci" | "pagerduty" | "airtable" | "calendly" | "zoom" | "customerio" | "sinch" | "workos" | "front" | "zendesk" | "twitch" | "paddle" | "recurly" | "docusign" | "vercel" | "intercom" | "paystack" | "authorize_net" | "sanity" | "square" | "trello" | "twilio" | "mandrill" | "hubspot" | "adyen" | "mailgun" | "mercado_pago" | "braintree" | "contentful" | "plivo" | "typeform" | "messagebird" | "netlify" | "vonage" | "monday" | "jira_connect" | "discord" | "telnyx" | "sendgrid" | "wise" | "kinde" | "paypal" | "aws_sns" | "plaid" | "ebay" | "gitlab" | "microsoft_graph" | "chargebee" | "postmark" | "sparkpost" | "okta" | "bigcommerce" | "datadog" | "brevo")[];
                /** @description Inclusive lower bound (RFC 3339 instant). */
                receivedAfter?: string;
                /** @description Exclusive upper bound (RFC 3339 instant). */
                receivedBefore?: string;
                /** @description Case-insensitive substring across id fields + header names/values. */
                search?: string;
                /** @description Filter by verification state: verified | failed | unattempted (repeatable). */
                verificationState?: ("verified" | "authenticated" | "failed" | "unattempted")[];
            };
            header?: never;
            path: {
                endpointId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EventsListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    eventsTail: {
        parameters: {
            query?: {
                /** @description Server-resolved grammar: now | beginning | <duration> | <RFC3339>. */
                since?: string;
                /** @description Opaque cursor to resume from (mutually exclusive with since). */
                sinceCursor?: string;
            };
            header?: never;
            path: {
                endpointId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EventsTailResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    endpointsListProviderSecrets: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                endpointId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EndpointsListProviderSecretsResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    endpointsAddProviderSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                endpointId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EndpointsAddProviderSecretRequest"];
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AddedProviderSecret"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    endpointsRevokeProviderSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                endpointId: string;
                secretId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RevokedProviderSecret"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    endpointsRevealIngestUrl: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                endpointId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EndpointsRevealIngestUrlResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    endpointsRotate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                endpointId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreatedEndpoint"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    eventsGet: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                eventId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Event"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    eventsGetPayload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                eventId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EventsGetPayloadResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    eventsReplay: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                eventId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EventsReplayRequest"];
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryAttempt"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
            502: components["responses"]["BadGateway"];
        };
    };
    replayDestinationsList: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReplayDestinationsListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    replayDestinationsCreate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReplayDestinationsCreateRequest"];
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreatedReplayDestination"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    replayDestinationsDelete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                destinationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReplayDestinationDeleted"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    replayDestinationsEnable: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                destinationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReplayDestination"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    replayDestinationsSetOrdered: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                destinationId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReplayDestinationsSetOrderedRequest"];
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReplayDestination"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    replayDestinationsRotateSigningSecret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                destinationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RotatedSigningSecret"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    replayDestinationsListSigningSecrets: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                destinationId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReplayDestinationsListSigningSecretsResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    subscriptionsList: {
        parameters: {
            query?: {
                /** @description Filter by source endpoint (empty = no filter). */
                sourceEndpointId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SubscriptionsListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    subscriptionsCreate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SubscriptionsCreateRequest"];
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Subscription"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    subscriptionsDelete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                subscriptionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SubscriptionDeleted"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    triggersList: {
        parameters: {
            query?: {
                /** @description Filter by endpoint (empty = no filter). */
                endpointId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TriggersListResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    triggersCreate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TriggersCreateRequest"];
            };
        };
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TriggersCreateResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    triggersRevoke: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                triggerId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TriggersRevokeResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    whoami: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthContext"];
                };
            };
            401: components["responses"]["Unauthorized"];
            500: components["responses"]["InternalError"];
        };
    };
}
