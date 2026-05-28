"""
Verkada webhook event schemas.

Every Verkada webhook shares a common envelope:

    {
      "org_id": "...",
      "webhook_id": "...",
      "webhook_type": "notification" | "lpr" | "sensor_alert" | "credential-notification",
      "created_at": <unix-seconds>,
      "data": { ... }
    }

The shape of ``data`` varies by ``webhook_type``, and for ``notification`` it
further splits by ``data.notification_type``. We group these into seven families:

    1. camera     — camera AI events (motion, POI, LPR-of-interest, tamper, etc.)
    2. access     — door / ACU events (door_opened, BLE unlock, NFC scan, etc.)
    3. lpr        — raw LPR detections (webhook_type=lpr, no notification_type)
    4. sensor     — environmental sensor alerts (webhook_type=sensor_alert)
    5. intercom   — intercom call/missed-call events
    6. credential — credential lifecycle events (created/updated/deleted),
                     uses webhook_type=credential-notification with a different
                     camelCase data shape (events[], eventType, grantorId, …)
    7. alarm      — Alarms: site state changes (arm/disarm) and incident events
                     (panic, trigger, resolved). Two outer webhook_types fall
                     here: alarm_site_state_changed + new_alarms.

Derived from 10K real captures (2026-05). See fixtures/ for one canonical
sample per family/variant.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field


CAMERA_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "alert_rule_motion",
        "alert_rule_line_crossing",
        "alert_rule_activity_recognition",
        "alert_rule_crowd",
        "alert_rule_dwell",
        "alert_rule_inactivity",
        "contextual_trigger_people_motion",
        "natural_language_event",
        "person_of_interest",
        "license_plate_of_interest",
        # Smart List match — a face/plate/object that hit a configured
        # Command "Smart List." Carries the same camera_id / image_url /
        # video_url shape as the other camera notifications; ``objects``
        # may be empty (face-list matches don't populate it).
        "smart_list",
        "tamper",
        "occlusion",
        "custom_event",
        "camera_status",
    }
)

ACCESS_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "door_opened",
        "door_held_open",
        "door_auxoutput_activated",
        "door_auxoutput_deactivated",
        "door_mobile_nfc_scan_accepted",
        "door_mobile_nfc_scan_rejected",
        "door_remote_unlock_accepted",
        "door_ble_unlock_attempt_accepted",
        "door_ble_unlock_attempt_rejected",
        "door_keycard_entered_accepted",
        "door_keycard_entered_rejected",
        "door_forced_open",
        "door_face_presented_accepted",
        "door_lp_presented_accepted",
        "door_lp_presented_rejected",
        "door_deactivated_credential_used",
        "door_tailgating",
        "door_acu_offline",
        "door_schedule_override_removed",
        # Lockdown lifecycle — fired when an Access scenario locks a
        # door (and a debounced variant Verkada emits to suppress
        # duplicate rapid-fire events). Carry lockdown_info +
        # scenario_info; door_id may be null on the debounced one.
        "door_lockdown",
        "door_lockdown_debounced",
    }
)

INTERCOM_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "intercom_missed_call",
        "intercom_call_triggered",
        "intercom_receiver_admitted",
        "intercom_status",
    }
)


# Alarm-family webhook types (outer ``webhook_type`` discriminator,
# similar to lpr / sensor_alert — no nested notification_type). Covers
# both site state changes (arm/disarm) and actual incident events from
# Verkada Alarms.
ALARM_WEBHOOK_TYPES: frozenset[str] = frozenset(
    {
        "alarm_site_state_changed",
        "new_alarms",
    }
)


class Envelope(BaseModel):
    """Common outer envelope for every Verkada webhook."""

    org_id: str
    webhook_id: str
    webhook_type: str
    created_at: int
    data: dict[str, Any]


class DoorInfoSite(BaseModel):
    name: str | None = None
    site_id: str | None = None


class DoorInfo(BaseModel):
    acu_name: str | None = None
    acu_id: str | None = None
    name: str | None = None
    door_id: str | None = None
    site: DoorInfoSite | None = None
    api_control_enabled: bool | None = None
    camera_info: Any | None = None
    timezone: str | None = None


class AccessEventData(BaseModel):
    event_id: str
    device_id: str
    created: int
    notification_type: str
    device_type: Literal["access_control"]
    door_id: str | None = None
    direction: str | None = None
    input_value: Any | None = None
    aux_info: Any | None = None
    user_info: Any | None = None
    lockdown_info: Any | None = None
    scenario_info: Any | None = None
    door_info: DoorInfo | None = None


class CameraEventData(BaseModel):
    event_id: str
    device_id: str
    created: int
    notification_type: str
    device_type: Literal["camera"]
    camera_id: str
    person_label: str | None = None
    objects: list[Any] = Field(default_factory=list)
    crowd_threshold: float | int | None = None
    image_url: str | None = None
    video_url: str | None = None
    event_description: str | None = None
    license_plate_number: str | None = None
    license_plate_state: str | None = None
    location: str | None = None
    location_lon: float | None = None
    location_lat: float | None = None
    camera_status: str | None = None


class LPRData(BaseModel):
    camera_id: str
    created: int
    detected: int
    license_plate_number: str
    confidence: float
    crop: list[float]
    image_url: str | None = None
    license_plate_state: str | None = None
    license_plate_state_confidence: float | None = None
    vehicle_image_url: str | None = None


class SensorAlertData(BaseModel):
    alert_event_id: str
    device_id: str
    device_name: str | None = None
    device_serial: str | None = None
    start_time: int
    end_time: int | None = None
    reading: str
    threshold: float
    most_extreme_value: float
    is_above_max_event: bool


class IntercomEventData(BaseModel):
    event_id: str
    device_id: str
    created: int
    notification_type: str
    device_type: str | None = None
    device_name: str | None = None
    start_timestamp: int | None = None
    end_timestamp: int | None = None
    answered_timestamp: int | None = None
    answered_by_name: str | None = None


class AlarmSiteStateChangedData(BaseModel):
    """webhook_type=alarm_site_state_changed — site arm/disarm/state events."""

    site_id: str
    site_name: str | None = None
    timestamp: int
    event_type: str  # "armed" | "disarmed" | etc.
    site_state: str
    site_security_level: str | None = None


class NewAlarmEventData(BaseModel):
    """webhook_type=new_alarms — actual alarm incidents (panic button,
    trigger fired, alarm resolved, etc.)."""

    alarm_id: str
    site_id: str
    site_name: str | None = None
    event_time: int
    event_type: str  # "alarm_resolved" | "alarm_triggered" | etc.
    response_id: str | None = None
    partition_id: str | None = None
    partition_name: str | None = None
    response_level: str | None = None
    trigger_type: str | None = None
    trigger_time: int | None = None
    trigger_device_id: str | None = None
    trigger_device_name: str | None = None
    trigger_device_type: str | None = None
    context_camera_ids: list[str] = Field(default_factory=list)
    incident_link: str | None = None
    is_silent: bool | None = None


class CredentialEventData(BaseModel):
    """Credential lifecycle webhook (webhook_type=credential-notification).

    Different camelCase shape from the other Verkada webhooks: a top-level
    ``eventType`` discriminator ("CREDENTIAL_CREATED" etc.) and a nested
    ``events`` list with per-credential detail. Issued by Verkada Access
    when a credential is created / modified / revoked / etc.
    """

    eventId: str
    eventType: str  # e.g. "CREDENTIAL_CREATED", "CREDENTIAL_UPDATED"
    timestamp: str  # ISO 8601, unlike the int-epoch used elsewhere
    grantorId: str
    grantorEmployeeId: str | None = None
    grantorExternalId: str | None = None
    events: list[Any] = Field(default_factory=list)


Family = Literal[
    "camera", "access", "lpr", "sensor", "intercom", "credential", "alarm", "unknown"
]


def classify(envelope: Envelope) -> Family:
    """Bucket an envelope into one of the seven known families (or ``unknown``)."""
    if envelope.webhook_type == "lpr":
        return "lpr"
    if envelope.webhook_type == "sensor_alert":
        return "sensor"
    if envelope.webhook_type == "credential-notification":
        return "credential"
    if envelope.webhook_type in ALARM_WEBHOOK_TYPES:
        return "alarm"
    if envelope.webhook_type == "notification":
        nt = envelope.data.get("notification_type") if isinstance(envelope.data, dict) else None
        if nt in CAMERA_EVENT_TYPES:
            return "camera"
        if nt in ACCESS_EVENT_TYPES:
            return "access"
        if nt in INTERCOM_EVENT_TYPES:
            return "intercom"
    return "unknown"


# Surfaced to the frontend so the trigger node can render family choices
# and field-level filter pickers without hardcoding strings in JS.
TAXONOMY: dict[str, dict[str, Any]] = {
    "camera": {
        "label": "Camera event",
        "webhook_type": "notification",
        "notification_types": sorted(CAMERA_EVENT_TYPES),
        # The picker is sample-driven, so each of these only surfaces when
        # an actual webhook of the selected notification_type carries the
        # field. Ordering here is "most likely to be the meaningful filter
        # for the type the user picked":
        #   - alert_rule_motion → objects
        #   - person_of_interest → person_label
        #   - LPR-flavored camera events → license_plate_number
        #   - camera_id is the universal fallback for "this camera only".
        "filter_fields": [
            "objects",
            "person_label",
            "license_plate_number",
            "camera_id",
        ],
    },
    "access": {
        "label": "Access / Door Event",
        "webhook_type": "notification",
        "notification_types": sorted(ACCESS_EVENT_TYPES),
        "filter_fields": ["door_id", "user_info", "direction"],
    },
    "lpr": {
        "label": "LPR Detection (raw)",
        "webhook_type": "lpr",
        "notification_types": None,
        "filter_fields": ["license_plate_number", "license_plate_state", "camera_id"],
    },
    "sensor": {
        "label": "Sensor Alert",
        "webhook_type": "sensor_alert",
        "notification_types": None,
        "filter_fields": ["reading", "device_name", "is_above_max_event"],
    },
    "intercom": {
        "label": "Intercom Event",
        "webhook_type": "notification",
        "notification_types": sorted(INTERCOM_EVENT_TYPES),
        "filter_fields": ["device_name", "answered_by_name"],
    },
    "credential": {
        "label": "Credential Lifecycle",
        "webhook_type": "credential-notification",
        "notification_types": None,
        "filter_fields": ["eventType", "grantorId"],
    },
    "alarm": {
        "label": "Alarms",
        # Two webhook_types fall into this bucket — site state changes
        # (arm/disarm) and incident events (panic, trigger, resolved).
        # Frontend filter uses the webhook_type field on the inbox row
        # to drill into one or the other.
        "webhook_type": sorted(ALARM_WEBHOOK_TYPES),
        "notification_types": None,
        "filter_fields": [
            "site_id",
            "site_name",
            "event_type",
            "trigger_type",
            "trigger_device_name",
        ],
    },
}
