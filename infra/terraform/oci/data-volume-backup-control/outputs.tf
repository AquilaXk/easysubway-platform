output "backup_policy_id" {
  value = oci_core_volume_backup_policy.data.id
}

output "backup_policy_assignment_id" {
  value = oci_core_volume_backup_policy_assignment.data.id
}

output "event_rule_id" {
  value = one(oci_events_rule.data_volume_backup_failed[*].id)
}

output "event_rule_enabled" {
  value = var.enable_backup_failure_event_rule
}

output "notification_topic_id" {
  value = oci_ons_notification_topic.data_volume_backup.id
}

output "subscription_id" {
  value = oci_ons_subscription.data_volume_backup.id
}

output "subscription_state" {
  value = oci_ons_subscription.data_volume_backup.state
}
