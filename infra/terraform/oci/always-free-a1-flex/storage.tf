resource "oci_core_volume" "data" {
  count = var.create_data_volume ? 1 : 0

  availability_domain = var.availability_domain
  compartment_id      = var.compartment_ocid
  display_name        = "${var.name_prefix}-data"
  freeform_tags       = local.common_tags
  size_in_gbs         = var.data_volume_size_in_gbs
  vpus_per_gb         = var.data_volume_vpus_per_gb
}

resource "oci_core_volume_attachment" "data" {
  count = var.create_data_volume ? 1 : 0

  attachment_type = "paravirtualized"
  device          = var.data_volume_device
  display_name    = "${var.name_prefix}-data-attachment"
  instance_id     = oci_core_instance.this.id
  is_read_only    = false
  is_shareable    = false
  volume_id       = oci_core_volume.data[0].id
}

resource "oci_core_volume_backup_policy" "data" {
  count = var.create_data_volume ? 1 : 0

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
  count = var.create_data_volume ? 1 : 0

  asset_id  = oci_core_volume.data[0].id
  policy_id = oci_core_volume_backup_policy.data[0].id
}
