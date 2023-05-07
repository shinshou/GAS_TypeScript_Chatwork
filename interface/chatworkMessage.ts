export interface jsonMessage {
    webhook_setting_id: string;
    webhook_event_type: string;
    webhook_event_time: number;
    webhook_event: {
        from_account_id: number;
        to_account_id: number;
        room_id: number;
        message_id: string;
        body: string;
        send_time: number;
        update_time: number;
    }
}