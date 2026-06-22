locals {
  instance_shape = "VM.Standard.A1.Flex"

  selected_image_id = var.source_image_ocid_override == null ? data.oci_core_images.ubuntu_a1[0].images[0].id : var.source_image_ocid_override

  selected_image_display_name = var.source_image_ocid_override == null ? data.oci_core_images.ubuntu_a1[0].images[0].display_name : "source_image_ocid_override"
  selected_image_time_created = var.source_image_ocid_override == null ? data.oci_core_images.ubuntu_a1[0].images[0].time_created : null

  common_tags = merge(
    {
      CostBoundary = "oci-always-free"
      ManagedBy    = "terraform"
      Project      = "easysubway"
    },
    var.freeform_tags
  )

  datapack_oci_base_url = "https://objectstorage.${var.region}.oraclecloud.com/n/${data.oci_objectstorage_namespace.this.namespace}/b/${oci_objectstorage_bucket.datapack.name}/o/${var.datapack_object_prefix}"
  datapack_base_url     = var.datapack_public_base_url_override == null ? local.datapack_oci_base_url : trimsuffix(var.datapack_public_base_url_override, "/")

  datapack_object_storage_endpoint = "https://${data.oci_objectstorage_namespace.this.namespace}.compat.objectstorage.${var.region}.oraclecloud.com"
}
