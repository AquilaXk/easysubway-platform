resource "oci_ons_notification_topic" "data_volume_backup" {
  count = var.create_data_volume ? 1 : 0

  compartment_id = var.compartment_ocid
  name           = "${var.name_prefix}-data-backup-failed"
  description    = "Data volume backup failure notifications."
  freeform_tags  = local.common_tags
}

resource "oci_ons_subscription" "data_volume_backup" {
  count = var.create_data_volume ? 1 : 0

  compartment_id = var.compartment_ocid
  endpoint       = var.data_volume_backup_alert_email
  protocol       = "EMAIL"
  topic_id       = oci_ons_notification_topic.data_volume_backup[0].id
  freeform_tags  = local.common_tags
}

resource "oci_events_rule" "data_volume_backup_failed" {
  count = var.create_data_volume ? 1 : 0

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
        volumeId = [oci_core_volume.data[0].id]
      }
    })
  }

  actions {
    action {
      action_type = "ONS"
      is_enabled  = true
      topic_id    = oci_ons_notification_topic.data_volume_backup[0].id
    }
  }
}
