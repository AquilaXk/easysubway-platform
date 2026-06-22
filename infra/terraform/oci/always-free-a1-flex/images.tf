# Latest Ubuntu image lookup. Pin source_image_ocid_override when reproducible applies matter more than latest-image tracking.
data "oci_core_images" "ubuntu_a1" {
  count = var.source_image_ocid_override == null ? 1 : 0

  compartment_id           = var.tenancy_ocid
  operating_system         = var.image_operating_system
  operating_system_version = var.image_operating_system_version
  shape                    = local.instance_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
  state                    = "AVAILABLE"
}
