resource "oci_core_instance" "this" {
  availability_domain  = var.availability_domain
  compartment_id       = var.compartment_ocid
  display_name         = var.name_prefix
  freeform_tags        = local.common_tags
  preserve_boot_volume = false
  shape                = local.instance_shape

  create_vnic_details {
    assign_public_ip = true
    display_name     = "${var.name_prefix}-primary-vnic"
    hostname_label   = var.hostname_label
    subnet_id        = oci_core_subnet.public.id
  }

  instance_options {
    are_legacy_imds_endpoints_disabled = true
  }

  metadata = {
    ssh_authorized_keys = trimspace(var.ssh_public_key)
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml", {
      data_volume_enabled    = tostring(var.create_data_volume)
      data_volume_device     = var.data_volume_device
      data_volume_mount_path = var.data_volume_mount_path
    }))
  }

  shape_config {
    memory_in_gbs = var.instance_memory_in_gbs
    ocpus         = var.instance_ocpus
  }

  source_details {
    boot_volume_size_in_gbs = var.boot_volume_size_in_gbs
    source_id               = local.selected_image_id
    source_type             = "image"
  }

  lifecycle {
    # Keep image and boot metadata drift from replacing a running host.
    ignore_changes = [metadata["user_data"], source_details[0].source_id]
  }
}
