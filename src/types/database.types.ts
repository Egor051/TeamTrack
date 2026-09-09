export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      audit_log: {
        Row: {
          action: Database["public"]["Enums"]["audit_action"]
          created_at: string
          entity_id: string | null
          entity_type: string
          id: number
          new_data: Json | null
          old_data: Json | null
          project_id: string | null
          user_id: string | null
        }
        Insert: {
          action: Database["public"]["Enums"]["audit_action"]
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: never
          new_data?: Json | null
          old_data?: Json | null
          project_id?: string | null
          user_id?: string | null
        }
        Update: {
          action?: Database["public"]["Enums"]["audit_action"]
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: never
          new_data?: Json | null
          old_data?: Json | null
          project_id?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      item_actions: {
        Row: {
          action: Database["public"]["Enums"]["item_action_type"]
          created_at: string
          id: number
          project_id: string
          task_id: string
          task_item_id: string
          user_id: string
        }
        Insert: {
          action: Database["public"]["Enums"]["item_action_type"]
          created_at?: string
          id?: never
          project_id: string
          task_id: string
          task_item_id: string
          user_id: string
        }
        Update: {
          action?: Database["public"]["Enums"]["item_action_type"]
          created_at?: string
          id?: never
          project_id?: string
          task_id?: string
          task_item_id?: string
          user_id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          body: string
          created_at: string
          data: Json
          dedupe_key: string
          id: string
          is_read: boolean
          project_id: string | null
          read_at: string | null
          task_id: string | null
          title: string
          type: Database["public"]["Enums"]["notification_type"]
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          data?: Json
          dedupe_key: string
          id?: string
          is_read?: boolean
          project_id?: string | null
          read_at?: string | null
          task_id?: string | null
          title: string
          type: Database["public"]["Enums"]["notification_type"]
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          data?: Json
          dedupe_key?: string
          id?: string
          is_read?: boolean
          project_id?: string | null
          read_at?: string | null
          task_id?: string | null
          title?: string
          type?: Database["public"]["Enums"]["notification_type"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name: string
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      project_members: {
        Row: {
          joined_at: string
          project_id: string
          role: Database["public"]["Enums"]["project_role"]
          user_id: string
        }
        Insert: {
          joined_at?: string
          project_id: string
          role?: Database["public"]["Enums"]["project_role"]
          user_id: string
        }
        Update: {
          joined_at?: string
          project_id?: string
          role?: Database["public"]["Enums"]["project_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_members_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          archived_at: string | null
          created_at: string
          created_by: string
          description: string | null
          id: string
          name: string
          status: Database["public"]["Enums"]["project_status"]
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          created_by: string
          description?: string | null
          id?: string
          name: string
          status?: Database["public"]["Enums"]["project_status"]
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          created_by?: string
          description?: string | null
          id?: string
          name?: string
          status?: Database["public"]["Enums"]["project_status"]
          updated_at?: string
        }
        Relationships: []
      }
      task_assignees: {
        Row: {
          assigned_at: string
          assigned_by: string
          task_id: string
          user_id: string
        }
        Insert: {
          assigned_at?: string
          assigned_by: string
          task_id: string
          user_id: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_assignees_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_items: {
        Row: {
          archived_at: string | null
          comment: string | null
          created_at: string
          description: string | null
          id: string
          is_archived: boolean
          is_completed: boolean
          percentage: number
          position: number
          task_id: string
          title: string
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          comment?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_archived?: boolean
          is_completed?: boolean
          percentage?: number
          position: number
          task_id: string
          title: string
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          comment?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_archived?: boolean
          is_completed?: boolean
          percentage?: number
          position?: number
          task_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_items_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_members: {
        Row: {
          approved_at: string
          approved_by: string
          created_at: string
          task_id: string
          user_id: string
        }
        Insert: {
          approved_at?: string
          approved_by: string
          created_at?: string
          task_id: string
          user_id: string
        }
        Update: {
          approved_at?: string
          approved_by?: string
          created_at?: string
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_members_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_template_items: {
        Row: {
          created_at: string
          description: string | null
          id: string
          position: number
          template_id: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          position: number
          template_id: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          position?: number
          template_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_template_items_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "task_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      task_templates: {
        Row: {
          archived_at: string | null
          created_at: string
          created_by: string
          description: string | null
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          created_by: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          created_by?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      tasks: {
        Row: {
          archived_at: string | null
          archived_by_project_at: string | null
          created_at: string
          created_by: string
          description: string | null
          id: string
          project_id: string
          status: Database["public"]["Enums"]["task_status"]
          title: string
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          archived_by_project_at?: string | null
          created_at?: string
          created_by: string
          description?: string | null
          id?: string
          project_id: string
          status?: Database["public"]["Enums"]["task_status"]
          title: string
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          archived_by_project_at?: string | null
          created_at?: string
          created_by?: string
          description?: string | null
          id?: string
          project_id?: string
          status?: Database["public"]["Enums"]["task_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_project_member: {
        Args: {
          p_project_id: string
          p_role: Database["public"]["Enums"]["project_role"]
          p_user_id: string
        }
        Returns: undefined
      }
      add_project_member_by_identifier: {
        Args: {
          p_identifier: string
          p_project_id: string
          p_role: Database["public"]["Enums"]["project_role"]
        }
        Returns: undefined
      }
      add_task_assignee: {
        Args: { p_task_id: string; p_user_id: string }
        Returns: undefined
      }
      approve_task_member: {
        Args: { p_task_id: string; p_user_id: string }
        Returns: undefined
      }
      archive_project: { Args: { p_project_id: string }; Returns: undefined }
      archive_task: { Args: { p_task_id: string }; Returns: undefined }
      archive_task_item: {
        Args: { p_task_item_id: string }
        Returns: undefined
      }
      archive_task_template: {
        Args: { p_template_id: string }
        Returns: undefined
      }
      change_member_role: {
        Args: {
          p_new_role: Database["public"]["Enums"]["project_role"]
          p_project_id: string
          p_user_id: string
        }
        Returns: undefined
      }
      create_project: {
        Args: { p_description?: string; p_name: string }
        Returns: string
      }
      create_task: {
        Args: { p_description?: string; p_project_id: string; p_title: string }
        Returns: string
      }
      create_task_from_template: {
        Args: {
          p_description?: string
          p_project_id: string
          p_template_id: string
          p_title?: string
        }
        Returns: string
      }
      create_task_item: {
        Args: {
          p_description?: string
          p_position?: number
          p_task_id: string
          p_title: string
        }
        Returns: string
      }
      create_task_template: {
        Args: { p_description?: string; p_name: string }
        Returns: string
      }
      create_task_template_item: {
        Args: {
          p_description?: string
          p_position?: number
          p_template_id: string
          p_title: string
        }
        Returns: string
      }
      delete_task_template_item: {
        Args: { p_item_id: string }
        Returns: undefined
      }
      get_task_template: { Args: { p_template_id: string }; Returns: Json }
      hard_delete_project: {
        Args: { p_project_id: string }
        Returns: undefined
      }
      hard_delete_task: { Args: { p_task_id: string }; Returns: undefined }
      hard_delete_task_item: {
        Args: { p_task_item_id: string }
        Returns: undefined
      }
      list_task_template_items: {
        Args: { p_template_id: string }
        Returns: {
          created_at: string
          description: string
          id: string
          template_id: string
          template_position: number
          title: string
          updated_at: string
        }[]
      }
      list_task_templates: {
        Args: never
        Returns: {
          created_at: string
          created_by: string
          description: string
          id: string
          item_count: number
          name: string
          updated_at: string
        }[]
      }
      mark_all_notifications_read: { Args: never; Returns: undefined }
      mark_notification_read: {
        Args: { p_notification_id: string }
        Returns: undefined
      }
      remove_project_member: {
        Args: { p_project_id: string; p_user_id: string }
        Returns: undefined
      }
      remove_task_assignee: {
        Args: { p_task_id: string; p_user_id: string }
        Returns: undefined
      }
      remove_task_template_item: {
        Args: { p_item_id: string }
        Returns: undefined
      }
      restore_project: { Args: { p_project_id: string }; Returns: undefined }
      restore_task: { Args: { p_task_id: string }; Returns: undefined }
      revoke_task_member: {
        Args: { p_task_id: string; p_user_id: string }
        Returns: undefined
      }
      set_task_item_comment: {
        Args: { p_comment: string; p_task_item_id: string }
        Returns: undefined
      }
      set_task_item_percentage: {
        Args: { p_percentage: number; p_task_item_id: string }
        Returns: number
      }
      set_task_item_progress: {
        Args: { p_completion_percent: number; p_task_item_id: string }
        Returns: number
      }
      set_task_item_state: {
        Args: { p_completed: boolean; p_task_item_id: string }
        Returns: boolean
      }
      transfer_project_ownership: {
        Args: { p_new_owner_id: string; p_project_id: string }
        Returns: undefined
      }
      update_my_profile: {
        Args: { p_display_name: string }
        Returns: {
          avatar_url: string | null
          created_at: string
          display_name: string
          id: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "profiles"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_project: {
        Args: { p_description: string; p_name: string; p_project_id: string }
        Returns: undefined
      }
      update_task: {
        Args: { p_description?: string; p_task_id: string; p_title?: string }
        Returns: undefined
      }
      update_task_item: {
        Args: {
          p_description?: string
          p_position?: number
          p_task_item_id: string
          p_title?: string
        }
        Returns: undefined
      }
      update_task_template: {
        Args: { p_description?: string; p_name?: string; p_template_id: string }
        Returns: undefined
      }
      update_task_template_item: {
        Args: {
          p_description?: string
          p_item_id: string
          p_position?: number
          p_title?: string
        }
        Returns: undefined
      }
    }
    Enums: {
      audit_action:
        | "created"
        | "updated"
        | "archived"
        | "member_added"
        | "member_removed"
        | "role_changed"
        | "access_approved"
        | "access_revoked"
        | "assignee_added"
        | "assignee_removed"
        | "checked"
        | "unchecked"
        | "reordered"
        | "restored"
        | "removed"
      item_action_type: "checked" | "unchecked"
      notification_type:
        | "task_member_added"
        | "task_member_removed"
        | "task_assigned"
        | "task_unassigned"
        | "task_item_changed"
        | "task_item_checked"
        | "task_item_unchecked"
        | "project_archived"
        | "project_restored"
        | "task_archived"
        | "task_restored"
      project_role: "owner" | "admin" | "member" | "viewer"
      project_status: "active" | "archived"
      task_status: "not_started" | "in_progress" | "completed" | "archived"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      audit_action: [
        "created",
        "updated",
        "archived",
        "member_added",
        "member_removed",
        "role_changed",
        "access_approved",
        "access_revoked",
        "assignee_added",
        "assignee_removed",
        "checked",
        "unchecked",
        "reordered",
        "restored",
        "removed",
      ],
      item_action_type: ["checked", "unchecked"],
      notification_type: [
        "task_member_added",
        "task_member_removed",
        "task_assigned",
        "task_unassigned",
        "task_item_changed",
        "task_item_checked",
        "task_item_unchecked",
        "project_archived",
        "project_restored",
        "task_archived",
        "task_restored",
      ],
      project_role: ["owner", "admin", "member", "viewer"],
      project_status: ["active", "archived"],
      task_status: ["not_started", "in_progress", "completed", "archived"],
    },
  },
} as const
