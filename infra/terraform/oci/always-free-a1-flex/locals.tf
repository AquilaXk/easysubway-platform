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

  # Canonical source: https://www.cloudflare.com/ips-v4/ (checked 2026-07-12).
  cloudflare_ipv4_source_url   = "https://www.cloudflare.com/ips-v4/"
  cloudflare_ipv4_checked_date = "2026-07-12"
  cloudflare_ipv4_ingress_cidrs = toset([
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22",
    "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
    "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22",
    "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ])

  datapack_oci_root_url = "https://objectstorage.${var.region}.oraclecloud.com/n/${data.oci_objectstorage_namespace.this.namespace}/b/${oci_objectstorage_bucket.datapack.name}/o"
  datapack_oci_base_url = var.datapack_object_prefix == "" ? local.datapack_oci_root_url : "${local.datapack_oci_root_url}/${var.datapack_object_prefix}"
  datapack_base_url     = var.datapack_public_base_url_override == null ? local.datapack_oci_base_url : trimsuffix(var.datapack_public_base_url_override, "/")

  datapack_object_storage_endpoint = "https://${data.oci_objectstorage_namespace.this.namespace}.compat.objectstorage.${var.region}.oraclecloud.com"
  datapack_custom_base_url_candidate = (
    var.datapack_object_prefix == ""
    ? "https://${var.datapack_domain_name}"
    : "https://${var.datapack_domain_name}/${var.datapack_object_prefix}"
  )
}
