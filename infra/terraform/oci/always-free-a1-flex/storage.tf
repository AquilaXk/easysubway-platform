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
