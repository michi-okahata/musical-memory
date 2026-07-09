class Argument {
    text: String = ""
    id: String = crypto.randomUUID();
    parentId: String = "";
    childrenIds: Array<String> = [];
}