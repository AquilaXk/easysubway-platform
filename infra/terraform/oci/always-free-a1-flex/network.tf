resource "oci_core_vcn" "this" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "${var.name_prefix}-vcn"
  dns_label      = var.vcn_dns_label
  freeform_tags  = local.common_tags
}

resource "oci_core_internet_gateway" "this" {
  compartment_id = var.compartment_ocid
  display_name   = "${var.name_prefix}-igw"
  enabled        = true
  freeform_tags  = local.common_tags
  vcn_id         = oci_core_vcn.this.id
}

resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_ocid
  display_name   = "${var.name_prefix}-public-rt"
  freeform_tags  = local.common_tags
  vcn_id         = oci_core_vcn.this.id

  route_rules {
    description       = "Public subnet outbound route"
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.this.id
  }
}

resource "oci_core_security_list" "public" {
  compartment_id = var.compartment_ocid
  display_name   = "${var.name_prefix}-public-sl"
  freeform_tags  = local.common_tags
  vcn_id         = oci_core_vcn.this.id

  egress_security_rules {
    description      = "Allow outbound traffic from the instance"
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
    protocol         = "all"
  }

  ingress_security_rules {
    description = "SSH ingress only from operator CIDR"
    protocol    = "6"
    source      = var.ssh_ingress_cidr
    source_type = "CIDR_BLOCK"

    tcp_options {
      max = 22
      min = 22
    }
  }

  ingress_security_rules {
    description = "HTTP ingress for staging"
    protocol    = "6"
    source      = var.http_ingress_cidr
    source_type = "CIDR_BLOCK"

    tcp_options {
      max = 80
      min = 80
    }
  }

  ingress_security_rules {
    description = "HTTPS ingress for staging"
    protocol    = "6"
    source      = var.https_ingress_cidr
    source_type = "CIDR_BLOCK"

    tcp_options {
      max = 443
      min = 443
    }
  }
}

resource "oci_core_subnet" "public" {
  cidr_block                 = var.subnet_cidr
  compartment_id             = var.compartment_ocid
  display_name               = "${var.name_prefix}-public-subnet"
  dns_label                  = var.subnet_dns_label
  freeform_tags              = local.common_tags
  prohibit_public_ip_on_vnic = false
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.public.id]
  vcn_id                     = oci_core_vcn.this.id
}
