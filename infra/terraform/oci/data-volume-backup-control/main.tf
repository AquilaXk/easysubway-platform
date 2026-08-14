locals {
  common_tags = {
    ManagedBy = "terraform"
    Project   = "EasySubway"
    Purpose   = "data-volume-backup"
  }
}

resource "oci_core_volume_backup_policy" "data" {
  compartment_id = var.compartment_ocid
  display_name   = "${var.name_prefix}-data-daily"
  freeform_tags  = local.common_tags

  schedules {
    backup_type       = "INCREMENTAL"
    period            = "ONE_DAY"
    retention_seconds = 345600
    hour_of_day       = 3
    offset_type       = "STRUCTURED"
    time_zone         = "REGIONAL_DATA_CENTER_TIME"
  }
}

resource "oci_core_volume_backup_policy_assignment" "data" {
  asset_id  = var.data_volume_ocid
  policy_id = oci_core_volume_backup_policy.data.id
}

resource "oci_ons_notification_topic" "data_volume_backup" {
  compartment_id = var.compartment_ocid
  name           = "${var.name_prefix}-data-backup-failed"
  description    = "Data volume backup failure notifications."
  freeform_tags  = local.common_tags
}

resource "oci_ons_subscription" "data_volume_backup" {
  compartment_id = var.compartment_ocid
  endpoint       = var.data_volume_backup_alert_email
  protocol       = "EMAIL"
  topic_id       = oci_ons_notification_topic.data_volume_backup.id
  freeform_tags  = local.common_tags
}

resource "oci_events_rule" "data_volume_backup_failed" {
  compartment_id = var.compartment_ocid
  display_name   = "${var.name_prefix}-data-backup-failed"
  description    = "Notify the owner when the scheduled data volume backup fails."
  is_enabled     = true
  freeform_tags  = local.common_tags

  condition_details {
    event_types = ["com.oraclecloud.blockvolumes.createvolumebackup.end"]
    data = jsonencode({
      status = ["operationFailed"]
      additionalDetails = {
        volumeId = [var.data_volume_ocid]
      }
    })
  }

  actions {
    action {
      action_type = "ONS"
      is_enabled  = true
      topic_id    = oci_ons_notification_topic.data_volume_backup.id
    }
  }
}
