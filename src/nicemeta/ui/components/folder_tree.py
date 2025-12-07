"""
Folder tree component for organizing queries and dashboards.
"""

from typing import Any, Callable

from nicegui import ui


class FolderTree:
    """
    Tree view component for folder navigation.
    
    Displays a hierarchical folder structure with items
    (queries, dashboards, etc.).
    """

    def __init__(
        self,
        folders: list[dict] | None = None,
        items: list[dict] | None = None,
        on_folder_select: Callable[[str], None] | None = None,
        on_item_select: Callable[[str], None] | None = None,
        on_item_double_click: Callable[[str], None] | None = None,
    ):
        """
        Initialize the folder tree.
        
        Args:
            folders: List of folder dictionaries with id, name, parent_id
            items: List of item dictionaries with id, name, folder_id, type
            on_folder_select: Callback when folder is selected
            on_item_select: Callback when item is selected
            on_item_double_click: Callback when item is double-clicked
        """
        self.folders = folders or []
        self.items = items or []
        self.on_folder_select = on_folder_select
        self.on_item_select = on_item_select
        self.on_item_double_click = on_item_double_click
        
        self.selected_folder: str | None = None
        self.selected_item: str | None = None

    def create(self) -> ui.element:
        """Create the folder tree widget."""
        with ui.card().classes("w-full h-full") as container:
            # Header with actions
            with ui.row().classes("items-center justify-between mb-2 px-2"):
                ui.label("Explorer").classes("font-semibold")
                
                with ui.row().classes("gap-1"):
                    ui.button(
                        icon="create_new_folder",
                        on_click=self._create_folder,
                    ).props("flat round dense").tooltip("New Folder")
                    
                    ui.button(
                        icon="refresh",
                        on_click=self._refresh,
                    ).props("flat round dense").tooltip("Refresh")
            
            # Tree content
            self._tree_container = ui.column().classes("w-full")
            self._render_tree()
        
        return container

    def _render_tree(self) -> None:
        """Render the folder tree structure."""
        self._tree_container.clear()
        
        with self._tree_container:
            # Root items (no parent)
            root_folders = [f for f in self.folders if not f.get("parent_id")]
            root_items = [i for i in self.items if not i.get("folder_id")]
            
            # Render root folders
            for folder in root_folders:
                self._render_folder(folder)
            
            # Render root items
            for item in root_items:
                self._render_item(item)

    def _render_folder(self, folder: dict, level: int = 0) -> None:
        """Render a folder and its contents."""
        folder_id = folder["id"]
        
        # Get child folders and items
        child_folders = [f for f in self.folders if f.get("parent_id") == folder_id]
        child_items = [i for i in self.items if i.get("folder_id") == folder_id]
        
        has_children = bool(child_folders or child_items)
        
        with ui.expansion(
            text=folder["name"],
            icon="folder",
            value=False,
        ).classes("w-full").style(f"margin-left: {level * 16}px"):
            # Folder actions (on hover)
            with ui.row().classes("items-center gap-1"):
                ui.button(
                    icon="add",
                    on_click=lambda f=folder: self._add_item_to_folder(f),
                ).props("flat round dense size=xs").tooltip("Add Query")
            
            # Render children
            for child_folder in child_folders:
                self._render_folder(child_folder, level + 1)
            
            for item in child_items:
                self._render_item(item, level + 1)

    def _render_item(self, item: dict, level: int = 0) -> None:
        """Render a single item (query/dashboard)."""
        item_type = item.get("type", "query")
        icon = "description" if item_type == "query" else "dashboard"
        
        is_selected = self.selected_item == item["id"]
        
        with ui.row().classes(
            f"items-center gap-2 px-2 py-1 cursor-pointer rounded "
            f"{'bg-blue-100' if is_selected else 'hover:bg-gray-100'}"
        ).style(f"margin-left: {level * 16}px") as row:
            row.on("click", lambda i=item: self._select_item(i))
            row.on("dblclick", lambda i=item: self._open_item(i))
            
            ui.icon(icon).classes("text-gray-500")
            ui.label(item["name"]).classes("text-sm truncate flex-grow")
            
            # Item menu
            with ui.button(icon="more_vert").props("flat round dense size=xs"):
                with ui.menu():
                    ui.menu_item("Open", lambda i=item: self._open_item(i))
                    ui.menu_item("Edit", lambda i=item: self._edit_item(i))
                    ui.menu_item("Duplicate", lambda i=item: self._duplicate_item(i))
                    ui.separator()
                    ui.menu_item("Delete", lambda i=item: self._delete_item(i))

    def _select_item(self, item: dict) -> None:
        """Handle item selection."""
        self.selected_item = item["id"]
        if self.on_item_select:
            self.on_item_select(item["id"])
        self._render_tree()

    def _open_item(self, item: dict) -> None:
        """Handle item double-click/open."""
        if self.on_item_double_click:
            self.on_item_double_click(item["id"])

    def _create_folder(self) -> None:
        """Create a new folder."""
        with ui.dialog() as dialog, ui.card():
            ui.label("New Folder").classes("text-lg font-semibold")
            name_input = ui.input(label="Name").classes("w-full")
            
            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button(
                    "Create",
                    on_click=lambda: self._do_create_folder(name_input.value, dialog),
                ).props("color=primary")
        
        dialog.open()

    def _do_create_folder(self, name: str, dialog) -> None:
        """Actually create the folder."""
        if name:
            # In production, save to database
            self.folders.append({
                "id": f"folder_{len(self.folders)}",
                "name": name,
                "parent_id": self.selected_folder,
            })
            self._render_tree()
            ui.notify(f"Created folder: {name}")
        dialog.close()

    def _add_item_to_folder(self, folder: dict) -> None:
        """Add a new item to a folder."""
        # In production, open create query/dashboard dialog
        ui.notify(f"Add item to: {folder['name']}")

    def _edit_item(self, item: dict) -> None:
        """Edit an item."""
        ui.notify(f"Edit: {item['name']}")

    def _duplicate_item(self, item: dict) -> None:
        """Duplicate an item."""
        ui.notify(f"Duplicate: {item['name']}")

    def _delete_item(self, item: dict) -> None:
        """Delete an item."""
        with ui.dialog() as dialog, ui.card():
            ui.label(f"Delete '{item['name']}'?").classes("text-lg")
            ui.label("This action cannot be undone.").classes("text-gray-500")
            
            with ui.row().classes("justify-end gap-2 mt-4"):
                ui.button("Cancel", on_click=dialog.close).props("flat")
                ui.button(
                    "Delete",
                    on_click=lambda: self._do_delete_item(item, dialog),
                ).props("color=negative")
        
        dialog.open()

    def _do_delete_item(self, item: dict, dialog) -> None:
        """Actually delete the item."""
        self.items = [i for i in self.items if i["id"] != item["id"]]
        self._render_tree()
        ui.notify(f"Deleted: {item['name']}")
        dialog.close()

    def _refresh(self) -> None:
        """Refresh the tree."""
        self._render_tree()
        ui.notify("Refreshed")

    def set_folders(self, folders: list[dict]) -> None:
        """Update the folder list."""
        self.folders = folders
        self._render_tree()

    def set_items(self, items: list[dict]) -> None:
        """Update the items list."""
        self.items = items
        self._render_tree()

