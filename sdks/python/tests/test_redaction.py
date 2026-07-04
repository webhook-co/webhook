from webhook_co._redaction import REDACTED, make_redactor, redact_well_known_secrets


class TestMakeRedactor:
    def test_replaces_a_known_secret(self) -> None:
        redact = make_redactor(["whk_supersecretvalue123"])
        assert (
            redact("key whk_supersecretvalue123 attached") == f"key {REDACTED} attached"
        )

    def test_replaces_every_occurrence(self) -> None:
        redact = make_redactor(["sk_abcdef123456"])
        assert (
            redact("sk_abcdef123456 and sk_abcdef123456")
            == f"{REDACTED} and {REDACTED}"
        )

    def test_redacts_multiple_distinct_secrets(self) -> None:
        redact = make_redactor(["whk_first_secret_aaa", "whsec_second_secret_bbb"])
        assert (
            redact("a=whk_first_secret_aaa b=whsec_second_secret_bbb")
            == f"a={REDACTED} b={REDACTED}"
        )

    def test_treats_regex_special_chars_literally(self) -> None:
        redact = make_redactor(["a.b*c(secret)+value"])
        assert redact("leak a.b*c(secret)+value here") == f"leak {REDACTED} here"
        assert redact("axbYcsecretZvalue") == "axbYcsecretZvalue"

    def test_ignores_empty_or_short_secrets(self) -> None:
        redact = make_redactor(["", "ab"])
        assert redact("ordinary text ab here") == "ordinary text ab here"

    def test_structural_backstop_catches_unregistered_token(self) -> None:
        redact = make_redactor(["whk_the_configured_key_xyz"])
        assert redact("other key whk_someOtherLeakedToken99") == f"other key {REDACTED}"


class TestRedactWellKnownSecrets:
    def test_redacts_whk_keys(self) -> None:
        assert (
            redact_well_known_secrets("token whk_AbC123_def-456 end")
            == f"token {REDACTED} end"
        )

    def test_redacts_whsec_secrets(self) -> None:
        assert (
            redact_well_known_secrets("secret whsec_MFRActualSecret done")
            == f"secret {REDACTED} done"
        )

    def test_redacts_bearer_credential(self) -> None:
        assert (
            redact_well_known_secrets("authorization: Bearer abc.def-ghi_123")
            == "authorization: Bearer [redacted]"
        )

    def test_leaves_ordinary_text_untouched(self) -> None:
        assert (
            redact_well_known_secrets("nothing sensitive, just prose")
            == "nothing sensitive, just prose"
        )
